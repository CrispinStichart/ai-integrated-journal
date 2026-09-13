# `webm-duration-fix` provenance

## Upstream snapshot

- Repository: <https://github.com/buynao/webm-duration-fix>
- Upstream package version: `1.0.4`
- Upstream repository tag: `v1.0.4`
- Selected commit: `87a71bf304c8cb4fbf19248ed5663e6aff9524ac`
- Retrieval date: 2026-09-13

The lightweight `v1.0.4` tag resolves to `05cad2b89ea5598c5659f1493c05173512d757b2`. The selected commit is a descendant of that tag. There are no changes under `src/` between the tag and the selected commit; the intervening repository change adds the MIT license file and changes the repository manifest's license field from `ISC` to `MIT`. Pinning both the version and selected commit therefore identifies the v1.0.4 implementation while retaining the repository's later license clarification.

The source import is limited to these files from the selected commit. Generated `lib/` files are not imported.

| Upstream path | SHA-256 at selected commit |
| --- | --- |
| `src/ebml/EBML.ts` | `410e0587ec606a21653903f54dcc9a7ebab42bde9a925012c111a165cd23bd90` |
| `src/ebml/EBMLDecoder.ts` | `f1ed0816b22b417ce3a3cfa9b3f671f6a2d4e004d809c57675fb1b0ffc5f596e` |
| `src/ebml/EBMLEncoder.ts` | `c4a7467d37e33a3dec6e121ca40e02f7a88daf183e20dbec04f38ca8176e36df` |
| `src/ebml/EBMLReader.ts` | `ea5e564418304a6897f37f6931d2152440ea03fbbf9cd34257b0edb73613fc57` |
| `src/ebml/ebmlID.ts` | `d5d960ed83cab48b0fde1e8aed02279a7f6c2edf481f4fc2d66f7eaaf8dc0300` |
| `src/ebml/index.ts` | `0949ce9b6cd0b429ae625b65d2c48b35f10180bb5d6ad54dca1b82fa7403a54a` |
| `src/ebml/tools-ebml.ts` | `6f367adddd335ba620bda41f8c498da16aa4b1bf300ccaf0ac6bfd0f7bf2aad6` |
| `src/ebml/tools.ts` | `771e5887b1287376306525a6b6b96bfc862cd04b7158484c00eb7764036acd81` |
| `src/index.ts` | `acb94b772e1b47f0ded22c44a423399d6d97899586fc9a1c703df836585899c3` |

The repository `README.md`, `.gitignore`, `yarn.lock`, `tsconfig.json`, and generated CommonJS declarations and JavaScript under `lib/` are excluded. The repository license and published npm manifest are retained separately as license evidence rather than implementation inputs.

## License records

The selected GitHub commit contains an MIT license with the original notice `Copyright (c) 2022 buynao law`. An exact copy is retained at [`upstream/GITHUB-MIT-LICENSE.txt`](upstream/GITHUB-MIT-LICENSE.txt) (SHA-256 `79f19c431f0f9a7466568e0cf7fd01800fa8d8fbdbd3139d6f89ea0a9cc9fad0`).

The npm registry tarball for `webm-duration-fix@1.0.4` instead declares `ISC` in `package.json` and omits a license file. An exact copy of that published manifest is retained at [`upstream/NPM-1.0.4-package.json`](upstream/NPM-1.0.4-package.json) (SHA-256 `4eb2ec26e8de2807bb85c224aaba443fb6dbafda57b2899aa9be9cf1266c1af2`). The published tarball has SHA-1 `fef235cb3d3ed3363507f705a7577dbb9fdedae6`, SHA-256 `19be7da9d57c78084ac351793527472d76f542d8845b0ccc0c8748dfd79cddda`, and npm integrity `sha512-kvhmSmEnuohtK+j+mJswqCCM2ViKb9W8Ch0oAxcaeUvpok5CsMORQLnea+CYKDXPG6JH12H0CbRK85qhfeZLew==`.

Both upstream records remain here intentionally. The ISC declaration is permissive and compatible with distributing this fork under MIT; it is not rewritten or presented as though it came with a notice that the npm tarball did not contain. The repository's original MIT copyright and permission notice is also reproduced in the fork's [`LICENSE`](LICENSE).

The vendored fork and all local modifications are distributed under MIT. The fork license adds `Copyright (c) 2026 AI Integrated Journal contributors` while preserving the upstream notice verbatim.

## Deliberate differences from upstream

This ledger must be updated whenever the vendored implementation changes.

| Area | Deliberate local difference |
| --- | --- |
| Licensing | The fork-level `LICENSE` adds the local contributors' copyright notice and applies MIT to the fork and local modifications while retaining the upstream MIT notice. |
| Provenance | This file pins the source import, records hashes and exclusions, and preserves the conflicting GitHub and npm license records. Upstream has no equivalent provenance document. |
| License evidence paths | The GitHub `LICENSE` and published npm `package.json` are stored under `upstream/` with descriptive names. Their contents are unmodified. |
| Implementation | None at provenance establishment. Any build-only import adjustments, characterization changes, or modernization must be added here in later tasks. |

## Updating the snapshot

Before importing a different upstream revision:

1. Fetch the repository tag and exact commit and fetch the corresponding npm tarball directly from the registry.
2. Verify the tag-to-commit relationship and diff the complete selected source set, not only release notes.
3. Recalculate the source-file and retained-record hashes above.
4. Review and retain every applicable copyright, permission, and manifest license record; do not normalize away discrepancies between distribution channels.
5. Update the import list, exclusions, deliberate-differences ledger, version, commit, retrieval date, and package tests in the same review.
