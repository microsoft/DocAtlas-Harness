# Editorial Web visual system

The user requested an interface refresh alongside the standalone migration,
referencing https://officeintelligence.github.io/ (reviewed 2026-10-09).
Its public CSS uses warm paper (`#fbfaf7`), ink (`#303a33`), green accents,
DM Sans UI text and Newsreader display text. Our interface adapts those principles
to a working reading surface, not the homepage's promotional layout or content.

The live entry serves locally packaged OFL DM Sans/Newsreader and existing Noto
Sans SC. Chinese body/display remain legible at native sizes; PDF canvas/text
geometry is not restyled with these UI fonts. Source PDF bytes and authorship
remain unchanged. All font license notices ship with the built assets.

Use a quieter header, an editorial landing hierarchy, a warm bordered composer,
readable line lengths, green actionable citations, amber verified passage cues,
and distinct refute/qualify colors. Research nodes retain their added/revised
semantics; color never replaces type/version/status text. All routes remain
keyboard accessible and responsive, with reduced-motion honored for portal
dialogs as well as the main app. Source/Note/Review controls are not removed.

Scope CSS to the live entry via `data-docatlas-ui=live`, including dialogs rendered
outside the app subtree. The accepted simulation prototype stays separate.
Desktop/mobile EN/中文 screenshots, focus/contrast checks, and actual PDF journeys
are acceptance evidence; a CSS diff alone is not visual acceptance.
