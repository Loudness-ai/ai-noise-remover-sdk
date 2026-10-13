const { test } = require("node:test");
const assert = require("node:assert/strict");
const { run } = require("../dist/cjs/process.js");
const kit = require("../dist/cjs/index.js");
test("Windows taskkill races confirm exit without accepting a still-live worker", async () => {
  const children = require("node:child_process");
  const { EventEmitter, once } = require("node:events");
  const actualSpawn = children.spawn;
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  for (const exits of [true, false]) {
    let owner,
      killerCalls = 0;
    const controller = new AbortController();
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    children.spawn = function (executable, args, options) {
      if (executable !== "taskkill") {
        owner = actualSpawn(executable, args, options);
        return owner;
      }
      killerCalls++;
      const killer = new EventEmitter();
      process.nextTick(() => killer.emit("close", 1));
      if (exits) setTimeout(() => owner.kill("SIGKILL"), 25);
      return killer;
    };
    try {
      await assert.rejects(
        run(
          process.execPath,
          ["-e", "console.log(process.pid);setInterval(()=>{},1000)"],
          {
            signal: controller.signal,
            onChunk: () => controller.abort(),
          },
        ),
        { code: exits ? "CANCELLED" : "TERMINATION_FAILED" },
      );
      assert.equal(killerCalls, 1);
      if (exits)
        assert.throws(() => process.kill(owner.pid, 0), { code: "ESRCH" });
      else assert.doesNotThrow(() => process.kill(owner.pid, 0));
    } finally {
      children.spawn = actualSpawn;
      Object.defineProperty(process, "platform", platform);
      if (owner && owner.exitCode === null && owner.signalCode === null) {
        owner.ref();
        const finished = once(owner, "exit");
        owner.kill("SIGKILL");
        await finished;
      }
    }
  }
});
test("already cancelled execution creates no process", async () => {
  await assert.rejects(
    run(process.execPath, ["-e", "process.exit(0)"], {
      signal: AbortSignal.abort(),
    }),
    { code: "CANCELLED" },
  );
});
test("missing executables and nonzero exits have typed errors", async () => {
  await assert.rejects(run("missing-audio-audit-executable", []), {
    code: "DEPENDENCY_MISSING",
  });
  await assert.rejects(run(process.execPath, ["-e", "process.exit(7)"]), {
    code: "PROCESS_FAILED",
  });
});
test("stdout capture is bounded", async () => {
  await assert.rejects(
    run(process.execPath, ["-e", 'process.stdout.write("x".repeat(100000))'], {
      maxStdoutBytes: 100,
    }),
    { code: "OUTPUT_LIMIT" },
  );
});
test("timeout terminates actual work", async () => {
  const start = Date.now();
  await assert.rejects(
    run(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeoutMs: 100,
    }),
    { code: "TIMEOUT" },
  );
  assert.ok(Date.now() - start < 4000);
});
test("AbortSignal stops stubborn owned process group", async () => {
  const c = new AbortController();
  let pid;
  const timer = setTimeout(() => c.abort(), 200);
  try {
    await assert.rejects(
      run(
        process.execPath,
        [
          "-e",
          'process.on("SIGTERM",()=>{});console.log(process.pid);setInterval(()=>{},1000)',
        ],
        {
          signal: c.signal,
          onChunk: (chunk) => {
            pid = Number(chunk.toString().trim());
          },
        },
      ),
      { code: "CANCELLED" },
    );
    assert.ok(pid);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    clearTimeout(timer);
  }
});
test("consumer failures stop work before rejecting", async () => {
  let pid;
  await assert.rejects(
    run(
      process.execPath,
      [
        "-e",
        'console.log(process.pid);setInterval(()=>console.log("tick"),100)',
      ],
      {
        onChunk: (chunk) => {
          pid = Number(chunk.toString().trim());
          throw new Error("consumer failed");
        },
      },
    ),
    /consumer failed/,
  );
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
test("progress callback failures do not break native completion", async () => {
  const result = await kit.doctor({
    onProgress: () => {
      throw Error("UI failure");
    },
  });
  assert.equal(result.ready, true);
});
test("cancellation interrupts a stalled asynchronous pipe consumer", async () => {
  const c = new AbortController();
  let pid;
  await assert.rejects(
    run(
      process.execPath,
      ["-e", "console.log(process.pid);setInterval(()=>{},1000)"],
      {
        signal: c.signal,
        onChunk(chunk) {
          pid = Number(chunk.toString().trim());
          c.abort();
          return new Promise(() => {});
        },
      },
    ),
    { code: "CANCELLED" },
  );
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
test("asynchronous observer rejection is isolated from processing", async () => {
  const a = kit.createAuditor({
    onState: async () => {
      throw Error("observer rejected");
    },
  });
  try {
    const r = await a.analyze("demo/sample.wav", {
      onProgress: async () => {
        throw Error("progress rejected");
      },
    });
    assert.equal(r.frames, 96000);
  } finally {
    await a.close();
  }
});
test(
  "transient permission errors while signalling a starting group are retried",
  { skip: process.platform === "win32" },
  async () => {
    const actualKill = process.kill;
    const controller = new AbortController();
    let denied = 0,
      pid;
    process.kill = function (target, signal) {
      if (target < 0 && signal === "SIGTERM" && denied < 2) {
        denied++;
        throw Object.assign(new Error("temporary spawn permission"), {
          code: "EPERM",
        });
      }
      return actualKill.call(process, target, signal);
    };
    try {
      await assert.rejects(
        run(
          process.execPath,
          ["-e", "console.log(process.pid);setInterval(()=>{},1000)"],
          {
            signal: controller.signal,
            onChunk: (bytes) => {
              pid = Number(bytes.toString().trim());
              controller.abort();
            },
          },
        ),
        { code: "CANCELLED" },
      );
      assert.equal(denied, 2);
      assert.throws(() => actualKill.call(process, pid, 0), { code: "ESRCH" });
    } finally {
      process.kill = actualKill;
    }
  },
);
test(
  "a group disappearing at startup still cancels its owned child",
  { skip: process.platform === "win32" },
  async () => {
    const actualKill = process.kill;
    const controller = new AbortController();
    let missing = false,
      pid;
    process.kill = function (target, signal) {
      if (target < 0 && signal === "SIGTERM" && !missing) {
        missing = true;
        throw Object.assign(new Error("group not yet available"), {
          code: "ESRCH",
        });
      }
      return actualKill.call(process, target, signal);
    };
    try {
      await assert.rejects(
        run(
          process.execPath,
          ["-e", "console.log(process.pid);setInterval(()=>{},1000)"],
          {
            signal: controller.signal,
            onChunk: (bytes) => {
              pid = Number(bytes.toString().trim());
              controller.abort();
            },
          },
        ),
        { code: "CANCELLED" },
      );
      assert.equal(missing, true);
      assert.throws(() => actualKill.call(process, pid, 0), { code: "ESRCH" });
    } finally {
      process.kill = actualKill;
    }
  },
);
