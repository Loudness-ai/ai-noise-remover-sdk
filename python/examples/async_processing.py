"""Single-job async processing. Set --cancel-after SECONDS to exercise cleanup."""

import argparse
import asyncio
import json
from pathlib import Path

from loudness_audio_kit import process_audio_async


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--cancel-after", type=float)
    args = parser.parse_args()
    task = asyncio.create_task(process_audio_async(args.input, args.output, mode="denoise"))
    timer = None
    if args.cancel_after is not None:
        timer = asyncio.get_running_loop().call_later(args.cancel_after, task.cancel)
    try:
        result = await task
        print(json.dumps(result["output"], indent=2))
    except asyncio.CancelledError:
        print("Cancelled; owned processing has stopped and private scratch is cleaned up.")
    finally:
        if timer:
            timer.cancel()


if __name__ == "__main__":
    asyncio.run(main())
