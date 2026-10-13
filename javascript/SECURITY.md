# Security

Report suspected package vulnerabilities privately through the maintainer's repository security channel when the public repository is established. Do not upload private recordings to a public issue; include a minimal rights-cleared reproduction, versions, command/options and stable error code.

The SDK accepts local files and trusted native executable paths, not remote URLs or playlist/concat inputs. Native decoders are not a sandbox: run untrusted media in a patched container/OS account with resource/network/filesystem isolation. The benchmark harness intentionally executes trusted caller-selected programs only after explicit execution opt-in; it is not a security sandbox.

The optional demo uses private generated paths, same-origin requests, bounded multipart inputs, admission/rate controls and disconnect cancellation. Add suitable HTTPS/ingress quotas for public deployment. Do not expose raw native logs or private filesystem paths. Public pretrained-asset distribution needs the documented provenance/license check. No website secrets or private runtime gateway are part of this source tree.
