# Changelog

## [1.1.1](https://github.com/donavynhaley/grimoire/compare/v1.1.0...v1.1.1) (2026-09-12)


### Bug Fixes

* keep mobile Markdown within the notes panel ([e66b8c8](https://github.com/donavynhaley/grimoire/commit/e66b8c8ed3120859c758c85b07a0b14ba5a4bd0a))
* keep mobile Markdown within the notes panel ([d7c8ee7](https://github.com/donavynhaley/grimoire/commit/d7c8ee7866b1106c41f645960cc2b1d7d5c29c98))
* **live:** guard seen writes before React renders disconnects ([2297059](https://github.com/donavynhaley/grimoire/commit/2297059a5d7f678a2d8156872f447123b3b14d00))
* **live:** prevent seen advances during stream reconciliation ([cba872f](https://github.com/donavynhaley/grimoire/commit/cba872f1453a3354e60ce72e4bc3b6db22ded039))
* **live:** reconcile workspace state after reconnecting ([5dc1842](https://github.com/donavynhaley/grimoire/commit/5dc1842c0e482852e928472d077ecbf8841d122b))
* **live:** reconcile workspace state after reconnecting ([b3a4d85](https://github.com/donavynhaley/grimoire/commit/b3a4d85e27289cdcb9f26af5c2573ab01ca6cb5f))
* **previews:** describe projects and keep page details private ([e191318](https://github.com/donavynhaley/grimoire/commit/e1913182f1b1c584daf0f1a8e8f72396698a8813))
* **previews:** describe projects and keep page details private ([028891a](https://github.com/donavynhaley/grimoire/commit/028891a864fec2b101e5bafc4d3cedc0b36bd4ce))
* **search:** make archived matches reachable beyond the result cap ([607b451](https://github.com/donavynhaley/grimoire/commit/607b45124b0a526253b8ce419e5fca243ab176e3))
* **search:** make archived matches reachable beyond the result cap ([e25a4d6](https://github.com/donavynhaley/grimoire/commit/e25a4d6df08a8d384c5f837a3e559a1b7ea75430))
* **ui:** keep project identity visible on narrow phones ([4bcd8e2](https://github.com/donavynhaley/grimoire/commit/4bcd8e2dcfca4e1a66f6c994e00428d3437b8705))
* **ui:** keep project identity visible on narrow phones ([31546e3](https://github.com/donavynhaley/grimoire/commit/31546e3c53f832d9060b63847a04a0ab25bf1a68))
* **workspace:** discard responses from previous project visits ([476848c](https://github.com/donavynhaley/grimoire/commit/476848ce4a079ca94f11580d85fff442ddf6c398))
* **workspace:** discard responses from previous project visits ([fda449f](https://github.com/donavynhaley/grimoire/commit/fda449fcfa7fe634a695a90ad21f1ef8b8c2e71c))


### Performance Improvements

* **ui:** load editor and settings features on demand ([9a0e4e5](https://github.com/donavynhaley/grimoire/commit/9a0e4e54ddd3c4bb19930a15059b66cabb7804cf))
* **ui:** load editor and settings features on demand ([9660b4c](https://github.com/donavynhaley/grimoire/commit/9660b4cce0e5b7e2c238a1c201dec431a686a563))

## [1.1.0](https://github.com/donavynhaley/grimoire/compare/v1.0.0...v1.1.0) (2026-09-09)


### Features

* **demo:** add an editable browser-only playground at /demo ([0606816](https://github.com/donavynhaley/grimoire/commit/06068163dcd3dc1d8e50421019ba230f38f92f61))
* **demo:** let visitors explore an editable browser-only board ([8c373c9](https://github.com/donavynhaley/grimoire/commit/8c373c99c97b6a22b13b6cf1cafe88153f57692a))


### Bug Fixes

* **auth:** bound bearer header parsing without backtracking ([a51a87e](https://github.com/donavynhaley/grimoire/commit/a51a87e17df83c6b09246a76efb75bbd8b170ffa))
* **auth:** bound bearer header parsing without backtracking ([fa08fbd](https://github.com/donavynhaley/grimoire/commit/fa08fbd34b05e8f918206a3fdbd4df4d4832a993))

## [1.0.0](https://github.com/donavynhaley/grimoire/compare/v0.6.1...v1.0.0) (2026-09-09)


### Features

* **auth:** give Google its own button, to Google's specification ([ba15f92](https://github.com/donavynhaley/grimoire/commit/ba15f92121f692623e37e868225b54fa75b0dff3))
* **auth:** let the allow list name a person, not only a domain ([29ddc3a](https://github.com/donavynhaley/grimoire/commit/29ddc3a40e886064c2632c43f649af915f4f9ccc))
* **auth:** OIDC sign-in, login rate limiting, and a content security policy ([7a2cc42](https://github.com/donavynhaley/grimoire/commit/7a2cc424cf0e2ffbbe2dfd66d6b0254b9ef6f6ad))
* **auth:** OIDC sign-in, login rate limiting, and a content security policy ([a860372](https://github.com/donavynhaley/grimoire/commit/a8603721bd5592781f1e245d07b2f06cdcfeb03d))
* **auth:** record the provider link, so a changed address follows the person ([7e76237](https://github.com/donavynhaley/grimoire/commit/7e762370664c440b46c35ec8a3d3e47fca72686c))
* **auth:** set up single sign-on from a screen, not a redeploy ([8fc1fc8](https://github.com/donavynhaley/grimoire/commit/8fc1fc89c91430d015d10e166465c113711715f2))
* **capture:** give a one-person project's pages to the one person ([c9b5744](https://github.com/donavynhaley/grimoire/commit/c9b57445113a98226d621fcea626d8fd738827c6))
* **capture:** put the page you just made one key away ([85cd661](https://github.com/donavynhaley/grimoire/commit/85cd661967569b69085a13a2424ac4a246a8448c))
* **import:** let the Notion importer belong to anyone's board ([0b898cc](https://github.com/donavynhaley/grimoire/commit/0b898cc5d9167f39a3ee586341818f7cc7df0878))
* **import:** let the settings screen import a Trello or Focalboard board ([8078fc7](https://github.com/donavynhaley/grimoire/commit/8078fc796995912278596b42585493818d0b2bd0))
* **import:** take a Trello or Focalboard board whole, from its own export ([5681c1f](https://github.com/donavynhaley/grimoire/commit/5681c1fdbd3fcd9c5ae1eb2e16e8f510193ed3bf))
* **import:** Trello and Focalboard importers ([169b4b5](https://github.com/donavynhaley/grimoire/commit/169b4b578fa1d4c5bc098646af7d956d5bbb912c))
* **import:** unfold the way out of the other tool, right on the import screen ([c043510](https://github.com/donavynhaley/grimoire/commit/c043510252695359e51003c9cd3c0bb5bac36b29))
* improve project transitions and chapter planning ([f9adfd4](https://github.com/donavynhaley/grimoire/commit/f9adfd4bf616d0ce5182aefe953debe17cf238c3))
* **mcp:** the one-page read finally uses the one-page route ([a3de569](https://github.com/donavynhaley/grimoire/commit/a3de569a90d3adde9f042816aca0a57b4df17514))
* **notes:** let the edit button hand over the Markdown itself ([e5d8c8e](https://github.com/donavynhaley/grimoire/commit/e5d8c8e48a818be1f0c08b69b40babfa7e5c347c))
* **notes:** let the edit button hand over the Markdown itself ([67bcf9b](https://github.com/donavynhaley/grimoire/commit/67bcf9bbc8563fa12d3621898680150ada2651c6))
* **onboarding:** greet a fresh install with a board that teaches itself ([e0d622e](https://github.com/donavynhaley/grimoire/commit/e0d622e75fe65429e896ddf6a80adb0c6b32d053))
* provide an isolated anonymous read-only demo ([e92a55c](https://github.com/donavynhaley/grimoire/commit/e92a55ca9bf50bb2a184f5c2ceeb9b5d164d3905))
* provide an isolated anonymous read-only demo ([b14650b](https://github.com/donavynhaley/grimoire/commit/b14650b3def3bcf34afd5ec8ab303cd366d265e9))
* **review:** what agents did waits for a person to look ([5acf1f7](https://github.com/donavynhaley/grimoire/commit/5acf1f70f7037c6b467ac05ddd22879180c2f055))


### Bug Fixes

* **a11y:** fix 20 real accessibility findings, account for the other 26 ([8bda2e0](https://github.com/donavynhaley/grimoire/commit/8bda2e01b02f230c84a2227d66b20bb7d01b20d4))
* **a11y:** the dialog keeps its modal promise, and the capture listbox says what it means ([25c5465](https://github.com/donavynhaley/grimoire/commit/25c54652d4b05bbcb08b05a7ab5a15236c72f77b))
* **account:** the project is resolved before the reply goes out ([335009e](https://github.com/donavynhaley/grimoire/commit/335009ed5b03f1b7aaba05efd3aff569c0a6ab1b))
* **auth:** accept the scheme-less issuer Google documents ([3b6e0af](https://github.com/donavynhaley/grimoire/commit/3b6e0af658d357e1a47e7f242d3b909dffc03cd4))
* **auth:** an unknown email costs one derivation, the same as a known one ([48e2eac](https://github.com/donavynhaley/grimoire/commit/48e2eacf5428087e63532ec3aa4e742cfa98a09c))
* **auth:** stop prefilling a personal address into every installation ([8e953f2](https://github.com/donavynhaley/grimoire/commit/8e953f254c8599dd3e2d6594defe0829cd8d3221))
* **auth:** the admin gate rests on a checked value, not a cast ([faaa5e9](https://github.com/donavynhaley/grimoire/commit/faaa5e9cb5dabc63b896c4ac8a67aea5f6a246ef))
* **auth:** the probe refuses like every other route ([cc305ac](https://github.com/donavynhaley/grimoire/commit/cc305ace041a19e08463b75c13a159d857316e5e))
* **auth:** two racing setup requests can no longer both become admin ([5ba67f4](https://github.com/donavynhaley/grimoire/commit/5ba67f41b05e0e92d1dcd0f75f73c2e3261398ed))
* **board:** a name the project does not know costs the page, not the board ([81ef775](https://github.com/donavynhaley/grimoire/commit/81ef775dc9707215bf9dbb2a9e899bc1773bb12d))
* **board:** open a project without taking the board off the screen ([2462136](https://github.com/donavynhaley/grimoire/commit/2462136898b255af99d801cefb5199cba6a38117))
* **capture:** give chapter names their column back in the picker ([d76f711](https://github.com/donavynhaley/grimoire/commit/d76f7113b922cd5a9a3b01374b2510451d539be8))
* **capture:** let the open offer die with its session, and restart the bar per notice ([1618fd2](https://github.com/donavynhaley/grimoire/commit/1618fd28a180fc2182e04a610037d29436c3229f))
* **chapters:** the close records its truth before any page travels ([610e3c1](https://github.com/donavynhaley/grimoire/commit/610e3c1d87754b3128f048216bb105f21e90ff72))
* **client:** a non-JSON failure becomes an ApiError, not a SyntaxError ([e740e15](https://github.com/donavynhaley/grimoire/commit/e740e15487a1100f26db08797eb8f7adbc925efc))
* **copy:** the last place the interface said cards says pages ([de6340b](https://github.com/donavynhaley/grimoire/commit/de6340ba217e0a3e8ea392e07be209c014540c45))
* **dialogs:** escape closes the library dialogs once, not twice ([7df21ef](https://github.com/donavynhaley/grimoire/commit/7df21ef0d8f40af8cafc7472df5754e8e5af62df))
* **discussion:** a vanished thread answers 404, not null ([33e514b](https://github.com/donavynhaley/grimoire/commit/33e514ba78e960c81f90f6c9d94d00979057f63b))
* expose only the demo gateway through an ingress network ([1bd349d](https://github.com/donavynhaley/grimoire/commit/1bd349dc8372070ee6469da78f1b477e2862ef9b))
* **header:** lower version label ([c167760](https://github.com/donavynhaley/grimoire/commit/c16776017e74edc80d709ff5fe1ba6b13fa937dc))
* **header:** nudge version label lower ([b413eea](https://github.com/donavynhaley/grimoire/commit/b413eea5925dabc4638583cbe3fcc69f188d43c8))
* **import:** give each guide fold its own state, so only one box ever animates ([2e75abc](https://github.com/donavynhaley/grimoire/commit/2e75abc8b93d16610acd733b6b53aa99b1f65f6a))
* **import:** hold the importers to what the real applications export ([bba27ef](https://github.com/donavynhaley/grimoire/commit/bba27ef067d7033e6f60d4c637ddc1516a16515d))
* **import:** refuse an estimate the board could never read, and say to back up first ([4195c15](https://github.com/donavynhaley/grimoire/commit/4195c159bfbe993c6e0e5dabf2e106a90bf7a602))
* **lint:** account for all 34 hook dependency warnings, then make the rule block ([93e776a](https://github.com/donavynhaley/grimoire/commit/93e776adf88aa7d91800dc940c3cf05277155430))
* **lint:** clear the last 8 Biome warnings and make those rules block ([986063c](https://github.com/donavynhaley/grimoire/commit/986063ca206315f5bc23c51913afc78ad7882298))
* **lint:** settle the 25 stylesheet warnings, and turn one rule off on purpose ([dc026f5](https://github.com/donavynhaley/grimoire/commit/dc026f57680627dc562dd8f9387d96c71f08cca1))
* **mcp:** point the package metadata at the grimoire repository ([53bd541](https://github.com/donavynhaley/grimoire/commit/53bd541023ed8472eba4cd42ae5e0ed9f350aa1b))
* **mcp:** update dependencies with published security fixes ([8d9a4b1](https://github.com/donavynhaley/grimoire/commit/8d9a4b12349e6683a359087a895c4fa2d1c5b078))
* **mcp:** update dependencies with published security fixes ([524978e](https://github.com/donavynhaley/grimoire/commit/524978e698b3a9eff55fe28906f86471dca8f35c))
* **members:** assignments clear only after the removal has committed ([d2a1158](https://github.com/donavynhaley/grimoire/commit/d2a1158ee57dbab14ba142c623abc5f5327f1dda))
* **motion:** the six holdouts adopt the one rule the product has about size ([d421566](https://github.com/donavynhaley/grimoire/commit/d42156681639d86db732bbde1724e5bf799621e9))
* **onboarding:** undo a failed seed, and let the starter pages tell the truth ([04f1fbf](https://github.com/donavynhaley/grimoire/commit/04f1fbf150292fba62bd35e28c37a82f2edfa04e))
* **pages:** refuse a decimal estimate at every edge, so one page can never stop a project loading ([#43](https://github.com/donavynhaley/grimoire/issues/43)) ([5563b12](https://github.com/donavynhaley/grimoire/commit/5563b12df018c3fc49f9dd8ff9684caaa8ac33cc))
* **repository:** definition changes touch the pages first and the row last ([f54c951](https://github.com/donavynhaley/grimoire/commit/f54c951e81ba0b714ee1177c88558f4e8769a2c1))
* **server:** a dead event stream costs itself, never the process ([c720280](https://github.com/donavynhaley/grimoire/commit/c720280a1ac5820723e3e425a85d7be87609bf42))
* **server:** a vanished file answers 404 instead of killing the process ([be143dc](https://github.com/donavynhaley/grimoire/commit/be143dc1de34a68b4c0ba2891cba244e0272a43b))
* **settings:** the agent token loader carries the unmount guard ([8dc8b4b](https://github.com/donavynhaley/grimoire/commit/8dc8b4b9c425260cfadefdf14e8f396fe0e7b973))
* **static:** containment is asserted, not assumed from prefix-stripping ([ae6c702](https://github.com/donavynhaley/grimoire/commit/ae6c702528104212a4c790681f0977c1e9a9b630))
* **storage:** archive and restore write the destination before removing the source ([2ddd454](https://github.com/donavynhaley/grimoire/commit/2ddd4543a8980893bb5f1a7a813179e041aa4de9))
* **test:** the mcp contract holds without the package's own install ([abca3da](https://github.com/donavynhaley/grimoire/commit/abca3da4706cc6833d1b6243b3c00f40a3134790))
* update nanoid and allow release verification on demand ([9b79fd5](https://github.com/donavynhaley/grimoire/commit/9b79fd52a6b9859da0b68ab696ee63b43d18122b))
