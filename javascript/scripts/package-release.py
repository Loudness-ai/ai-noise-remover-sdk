"""Create deterministic, allowlisted local source, Docker Space and review archives."""
from pathlib import Path
import gzip
import hashlib
import io
import json
import re
import tarfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts'
OUT.mkdir(exist_ok=True)
VERSION = json.loads((ROOT / 'package.json').read_text())['version']
PREFIX = f'loudness-ai-audio-kit-{VERSION}'
ALLOWED = ['src', 'models', 'schemas', 'docs', 'scripts', 'tests', 'examples', 'demo', '.github',
           'package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'LICENSE', 'DISTRIBUTION-LICENSE', 'NOTICE', 'third-party',
           'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', '.gitignore', '.dockerignore']
BLOCKED = {'node_modules', 'artifacts', '.git', '.DS_Store', '.reference-venv', '.qa-node24'}
source = {}
for item in ALLOWED:
    base = ROOT / item
    if not base.exists():
        raise RuntimeError(f'Missing source item: {item}')
    paths = base.rglob('*') if base.is_dir() else [base]
    for path in paths:
        relative = path.relative_to(ROOT)
        if any(part in BLOCKED for part in relative.parts):
            continue
        if path.is_symlink():
            raise RuntimeError(f'Refusing a source symlink: {relative}')
        if path.is_file():
            source[str(relative)] = (path.read_bytes(), 0o755 if path.stat().st_mode & 0o111 else 0o644)


def archive(filename, entries, prefix):
    target = OUT / filename
    with target.open('wb') as raw, gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=0) as zipped:
        with tarfile.open(fileobj=zipped, mode='w') as tar:
            for name, (data, mode) in sorted(entries.items()):
                info = tarfile.TarInfo(prefix + '/' + name)
                info.size, info.mode, info.mtime = len(data), mode, 0
                info.uid = info.gid = 0
                tar.addfile(info, io.BytesIO(data))
    with tarfile.open(target) as tar:
        members = tar.getmembers()
        if len(members) != len(entries) or any('..' in Path(m.name).parts or not m.isfile() for m in members):
            raise RuntimeError('Archive member verification failed')
        for member in members:
            name = str(Path(member.name).relative_to(prefix))
            if hashlib.sha256(tar.extractfile(member).read()).digest() != hashlib.sha256(entries[name][0]).digest():
                raise RuntimeError(f'Archive byte mismatch: {name}')
    return {'filename': filename, 'bytes': target.stat().st_size,
            'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'files': len(entries)}


snapshot = hashlib.sha256(''.join(name + '\0' + hashlib.sha256(data).hexdigest() + '\n' for name,(data,mode) in sorted(source.items())).encode()).hexdigest()
fresh = json.loads((OUT / 'fresh-source-verification.json').read_text())
if fresh.get('result') != 'passed' or fresh.get('sourceSha256') != snapshot:
    raise RuntimeError('Fresh verification does not match final source snapshot')

archives = [archive(PREFIX + '-source.tar.gz', source, PREFIX)]
space = dict(source)
space['SDK-README.md'] = space['README.md']
space['README.md'] = source['demo/README.md']
space['Dockerfile'] = source['demo/Dockerfile']
archives.append(archive(PREFIX + '-huggingface.tar.gz', space, PREFIX + '-space'))
evidence_names = [
    'macos-node22-tests.log', 'macos-node24-tests.log', 'linux-node22-tests.log', 'linux-node24-tests.log',
    'processing-evidence.json', 'one-hour-processing.json', 'long-file-evidence.json', 'independent-reference.json',
    'fresh-source-verification.json', 'fresh-source-verification.log', 'container-smoke-linux-arm64.json',
    'container-smoke-linux-amd64.json', 'disk-exhaustion.json', 'network-isolation.json',
    'demo-browser-verification.json', 'demo-desktop.png', 'demo-mobile.png', 'demo-entry-desktop.png', 'demo-entry-mobile.png',
    'browser-enhanced.wav', 'narration-a-noisy.wav', 'narration-a-denoised.wav', 'narration-b-noisy.wav', 'narration-b-denoised.wav',
    'protected-site-check.json', 'package-receipt.json', 'dependency-audit.json', 'demo-dependency-audit.json',
    'schema-check.log', 'lint.log', 'types.log', 'package-verification.log', 'linux-installed-release.json', 'macos-node24-installed-release.json',
]
evidence = {}
for name in evidence_names:
    path = OUT / name
    if not path.is_file():
        raise RuntimeError(f'Required evidence is missing: {name}')
    evidence[name] = (path.read_bytes(), 0o644)
archives.append(archive(PREFIX + '-evidence.tar.gz', evidence, PREFIX + '-evidence'))
package = json.loads((OUT / 'package-receipt.json').read_text())
tarball = OUT / package['filename']
if hashlib.sha256(tarball.read_bytes()).hexdigest() != package['sha256']:
    raise RuntimeError('Tarball differs from installed verification receipt')
files = [{'filename': tarball.name, 'bytes': tarball.stat().st_size, 'sha256': package['sha256']}, *archives]
tests = {}
for name in ['macos-node22', 'macos-node24', 'linux-node22', 'linux-node24']:
    log = (OUT / (name + '-tests.log')).read_text()
    counts = {label: re.findall(r'(?:# |ℹ )' + label + r' (\d+)', log) for label in ['tests', 'pass', 'fail', 'skipped']}
    if any(not value for value in counts.values()):
        raise RuntimeError(f'Missing test totals: {name}')
    result = {key: int(value[-1]) for key, value in counts.items()}
    if result['fail'] or result['tests'] != result['pass'] or result['skipped']:
        raise RuntimeError(f'Test failure/skip in verified Unix matrix: {name}')
    tests[name] = result
for filename in ['linux-installed-release.json', 'macos-node24-installed-release.json']:
    receipt = json.loads((OUT / filename).read_text())
    if receipt.get('sha256') != package['sha256'] or receipt.get('result') != 'passed':
        raise RuntimeError(f'Installed artifact is stale/failed: {filename}')
receipt = {
    'name': package['name'], 'version': VERSION,
    'state': 'verified local SDK/CLI/demo release candidate', 'publiclyPublished': False,
    'localAudioProcessing': True, 'hostedApiRequired': False,
    'artifacts': files, 'automatedTests': tests,
    'freshSource': json.loads((OUT / 'fresh-source-verification.json').read_text()),
    'linuxInstalledRelease': json.loads((OUT / 'linux-installed-release.json').read_text()),
    'macosNode24InstalledRelease': json.loads((OUT / 'macos-node24-installed-release.json').read_text()),
    'workspaceProtection': json.loads((OUT / 'protected-site-check.json').read_text()),
    'publicReleaseGates': ['exact pretrained graph checkpoint/export and redistribution terms',
                          'native Windows execution', 'publisher/repository/organization identity and publication action'],
    'evidenceLimits': ['two English seeded-noise fixtures are not a representative quality study',
                       '100ms sampled RSS is not a hard allocation cap', 'linuxamd64 smoke ran under emulation'],
}
(OUT / 'release-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
(OUT / 'SHA256SUMS').write_text(''.join(f'{f["sha256"]}  {f["filename"]}\n' for f in files))
print(json.dumps({'state':receipt['state'],'artifacts':files,'tests':tests,'publiclyPublished':False},indent=2))
