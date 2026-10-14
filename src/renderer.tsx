/**
 * HTML shell renderer.
 *
 * Delivers a mobile-first application shell (PRD §71–§93). The app runs as a
 * single-page client against the JSON API; the server's only job here is to
 * emit the document, the design tokens, and any boot data a deep link needs
 * (an artifact id, or a share token) so the first render is correct without a
 * round trip.
 *
 * The shell is intentionally the same document for /, /library, /a/:id and
 * /s/:token: one cached document, and no server-rendered content that could
 * leak across a permission boundary.
 */

import type { Context } from 'hono'
import type { AppEnv } from './middleware'
import { readShareGrantCookie } from './lib/http'

export interface ShellOptions {
  route: string
  artifactId?: string
  shareToken?: string
  initialData?: unknown
}

/** Serialise boot data for inline embedding without breaking out of <script>. */
function serializeBoot(data: unknown): string {
  return JSON.stringify(data ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * The design tokens are declared in CSS rather than Tailwind's config so the
 * palette is available to plain CSS too (the preview iframe and share page
 * do not load Tailwind).
 */
const DESIGN_TOKENS = `
  :root {
    /* Artifactry brand palette (logo kit v1.0).

       Ink  #12151C  tile, wordmark and body text
       Volt #B8F23A  brand highlight — 1.33:1 on white, so it can never carry
                     text or primary UI meaning on a light surface
       Paper #F5F6F2 light background

       --accent is Volt Deep #4E7A00 rather than Volt: it is the accessible
       face of the same green (5.11:1 on white, 4.71:1 on Paper) and is what
       buttons, links, focus rings and selected controls use. Volt is kept as
       --volt for brand highlights only. */
    --ink: #12151c;
    --volt: #b8f23a;
    --paper: #f5f6f2;

    /* Type (logo kit v1.0, "Wordmark"): Inter for UI text, JetBrains Mono
       for code, IDs and URLs. The wordmark itself is outlined artwork and
       never depends on these. */
    --font-sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;

    --bg: #f5f6f2;          /* Paper */
    --surface: #ffffff;
    --surface-2: #eef0e9;   /* warm tint of Paper; replaces the old cool grey */
    --border: #e2e4da;
    --text: #12151c;        /* Ink */
    --text-2: #5a6066;
    --text-3: #7e858b;
    --accent: #4e7a00;      /* Volt Deep */
    --accent-weak: #eef9dc; /* Volt tint for selected/active surfaces */
    --danger: #d92d20;
    --danger-weak: #fef3f2;
    --success: #067647;
    --success-weak: #ecfdf3;
    --warning: #b54708;
    --warning-weak: #fffaeb;
    --radius: 14px;
    --radius-sm: 10px;
    --shadow-1: 0 1px 2px rgba(18, 21, 28, 0.05);
    --shadow-2: 0 4px 14px rgba(18, 21, 28, 0.08);
    --nav-h: 62px;
    --safe-top: env(safe-area-inset-top, 0px);
    --safe-bottom: env(safe-area-inset-bottom, 0px);

    /* Responsive layout system.
       Mobile-first: no sidebar, full-bleed content, bottom navigation.
       The breakpoints below progressively introduce a centred content
       column, denser grids and a persistent left rail. */
    --nav-w: 0px;          /* width reserved for a left rail (desktop only) */
    --content-max: none;   /* max width of the content column */
    --content-pad: 16px;   /* horizontal page padding */
  }

  * { -webkit-tap-highlight-color: transparent; }

  html, body {
    margin: 0;
    padding: 0;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-sans);
    -webkit-font-smoothing: antialiased;
  }

  /* Global guard: nothing in the app may introduce horizontal scrolling (PRD §73) */
  html, body { overflow-x: hidden; max-width: 100vw; }

  /* Application shell.
     Mobile: full-bleed, bottom navigation, no reserved rail.
     Tablet/desktop: the content column is centred and bounded (widened by the
     breakpoints below), and on desktop a fixed left rail replaces the bottom
     bar so the layout uses the screen rather than stretching phone cards.
     (Supersedes the former hard 430px desktop lock.) */
  #shell {
    width: 100%;
    max-width: 100%;
    margin-left: auto;
    margin-right: auto;
    box-sizing: border-box;
    background: var(--bg);
    min-height: 100vh;
    min-height: 100dvh;
    position: relative;
    overflow-x: hidden;
    padding-left: var(--nav-w);
  }

  .app-main {
    padding: 0 var(--content-pad) calc(var(--nav-h) + var(--safe-bottom) + 20px);
    box-sizing: border-box;
    width: 100%;
    max-width: var(--content-max);
    margin-left: auto;
    margin-right: auto;
  }

  .app-header {
    position: sticky;
    top: 0;
    z-index: 20;
    background: rgba(245, 246, 242, 0.86);
    backdrop-filter: saturate(180%) blur(12px);
    -webkit-backdrop-filter: saturate(180%) blur(12px);
    border-bottom: 1px solid transparent;
    padding-top: var(--safe-top);
    box-sizing: border-box;
  }
  .app-header.is-scrolled { border-bottom-color: var(--border); }

  /* Touch targets: 44px minimum, 48px for primary actions (PRD §74) */
  .tap { min-height: 44px; }
  .tap-lg { min-height: 48px; }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-1);
    box-sizing: border-box;
    width: 100%;
  }

  /* Copyable snippets on the Connect page and handoff screens */
  .code-snippet {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    border: 1px solid var(--border);
  }
  .code-snippet pre {
    margin: 0;
    width: 100%;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .connect-steps { margin: 6px 0 10px; padding-left: 20px; font-size: 13px; line-height: 1.55; color: var(--text); }
  .connect-steps li + li { margin-top: 4px; }

  /* First-run checklist */
  .first-run-dot {
    width: 18px; height: 18px; flex: none; border-radius: 50%;
    border: 2px solid var(--border); box-sizing: border-box;
  }
  .first-run-dot.is-done { background: var(--accent); border-color: var(--accent); }

  /* Plain-text and code files on the detail screen */
  .text-preview {
    margin: 0;
    max-height: 70vh;
    overflow: auto;
    padding: 14px;
    border-radius: var(--radius);
    background: var(--surface);
    border: 1px solid var(--border);
    font-family: var(--font-mono);
    font-size: 12.5px;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 9px;
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 550;
    background: var(--surface-2);
    color: var(--text-2);
    white-space: nowrap;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    min-height: 48px;
    padding: 0 16px;
    border-radius: 12px;
    border: 1px solid transparent;
    font-size: 15px;
    font-weight: 560;
    cursor: pointer;
    transition: transform .06s ease, background .15s ease, opacity .15s ease;
    box-sizing: border-box;
  }
  .btn:active { transform: scale(0.985); }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn-primary { background: var(--text); color: #fff; }
  .btn-accent { background: var(--accent); color: #fff; }
  .btn-secondary { background: var(--surface); color: var(--text); border-color: var(--border); }
  .btn-ghost { background: transparent; color: var(--text-2); min-height: 44px; }
  .btn-danger { background: var(--danger-weak); color: var(--danger); border-color: #fecdca; }
  .btn-block { width: 100%; }

  .input {
    width: 100%;
    box-sizing: border-box;
    min-height: 48px;
    padding: 12px 14px;
    border-radius: 12px;
    border: 1px solid var(--border);
    background: var(--surface);
    font-size: 16px; /* prevents iOS zoom-on-focus */
    font-family: inherit;
    color: var(--text);
  }
  .input:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent; }
  .input::placeholder { color: var(--text-3); }

  textarea.input { min-height: 96px; resize: vertical; line-height: 1.5; }
  select.input { appearance: none; background-image: none; }

  /* Visible focus for keyboard users (PRD §113) */
  :focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 6px;
  }

  /* Bottom navigation (§77, §78) */
  .bottom-nav {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    bottom: 0;
    width: 100%;
    max-width: 430px;
    height: calc(var(--nav-h) + var(--safe-bottom));
    padding-bottom: var(--safe-bottom);
    background: rgba(255,255,255,0.94);
    backdrop-filter: saturate(180%) blur(14px);
    -webkit-backdrop-filter: saturate(180%) blur(14px);
    border-top: 1px solid var(--border);
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    align-items: center;
    z-index: 40;
    box-sizing: border-box;
  }
  .nav-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    min-height: 48px;
    border: 0;
    background: none;
    color: var(--text-3);
    font-size: 10.5px;
    font-weight: 550;
    cursor: pointer;
    font-family: inherit;
    padding: 0;
  }
  .nav-item[aria-current="page"] { color: var(--text); }
  .nav-item svg { width: 21px; height: 21px; }

  /* Centre Add action gets visual emphasis (§77) */
  .nav-add {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 46px;
    height: 46px;
    margin: 0 auto;
    border-radius: 999px;
    background: var(--text);
    color: #fff;
    border: 0;
    cursor: pointer;
    box-shadow: var(--shadow-2);
  }
  .nav-add:active { transform: scale(0.95); }
  .nav-add svg { width: 22px; height: 22px; }

  /* Bottom sheets (§79) — the mobile-native alternative to modal dialogs */
  .sheet-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(18, 21, 28, 0.42);
    z-index: 60;
    opacity: 0;
    transition: opacity .2s ease;
  }
  .sheet-backdrop.is-open { opacity: 1; }

  .sheet {
    position: fixed;
    left: 50%;
    transform: translateX(-50%) translateY(100%);
    bottom: 0;
    width: 100%;
    max-width: 430px;
    max-height: 88vh;
    background: var(--surface);
    border-radius: 20px 20px 0 0;
    z-index: 61;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    transition: transform .26s cubic-bezier(.32,.72,0,1);
    padding-bottom: var(--safe-bottom);
  }
  .sheet.is-open { transform: translateX(-50%) translateY(0); }
  .sheet-grabber {
    width: 38px; height: 4px; border-radius: 999px;
    background: #d5d8ce; margin: 10px auto 2px; flex: none;
  }
  .sheet-body { overflow-y: auto; padding: 8px 16px 20px; box-sizing: border-box; }

  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 52px;
    padding: 10px 0;
    border: 0;
    background: none;
    text-align: left;
    cursor: pointer;
    font-family: inherit;
    font-size: 15px;
    color: var(--text);
  }
  .row + .row { border-top: 1px solid var(--border); }

  .skeleton {
    background: linear-gradient(90deg, #eef0e9 25%, #e4e6dd 37%, #eef0e9 63%);
    background-size: 400% 100%;
    animation: shimmer 1.4s ease-in-out infinite;
    border-radius: 8px;
  }
  @keyframes shimmer { 0% { background-position: 100% 50%; } 100% { background-position: 0 50%; } }

  .spinner {
    width: 18px; height: 18px;
    border: 2px solid rgba(255,255,255,.35);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin .7s linear infinite;
  }
  .spinner-dark { border-color: rgba(18,21,28,.2); border-top-color: var(--text); }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Toast */
  .toast-host {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    bottom: calc(var(--nav-h) + var(--safe-bottom) + 14px);
    width: calc(100% - 32px);
    max-width: 398px;
    z-index: 80;
    display: flex;
    flex-direction: column;
    gap: 8px;
    pointer-events: none;
  }
  .toast {
    background: #12151c;
    color: #fff;
    font-size: 13.5px;
    line-height: 1.45;
    padding: 11px 14px;
    border-radius: 12px;
    box-shadow: var(--shadow-2);
    animation: toast-in .22s ease;
    pointer-events: auto;
  }
  .toast-error { background: var(--danger); }
  .toast-success { background: var(--success); }
  @keyframes toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

  .preview-frame {
    width: 100%;
    height: 440px;
    border: 0;
    border-radius: var(--radius);
    background: #fff;
    display: block;
  }

  .empty-state {
    text-align: center;
    padding: 44px 20px;
    color: var(--text-2);
  }
  .empty-state svg { width: 40px; height: 40px; color: var(--text-3); margin-bottom: 12px; }

  .divider { height: 1px; background: var(--border); border: 0; margin: 0; }

  .list-row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 60px;
    padding: 12px 14px;
    box-sizing: border-box;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    text-align: left;
    cursor: pointer;
    font-family: inherit;
    color: var(--text);
  }

  .thumbs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }

  /* Metric tiles. 2-up on phones; the breakpoints below widen the row so an
     analytics or admin view reads as a dashboard rather than a stacked list. */
  .stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }

  .stat-tile {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px;
    box-sizing: border-box;
  }
  .stat-value { font-size: 24px; font-weight: 640; letter-spacing: -0.02em; line-height: 1.1; }
  .stat-label { font-size: 12px; color: var(--text-2); margin-top: 3px; }

  /* Library filters: one scrolling row per facet (file type, collection). */
  .filter-label { font-size: 11.5px; font-weight: 600; color: var(--text-3); text-transform: uppercase;
    letter-spacing: .05em; margin: 0 0 6px; }
  .filter-row { display: flex; gap: 7px; overflow-x: auto; padding-bottom: 4px; margin-bottom: 12px; }
  .filter-pill {
    display: inline-flex; align-items: center; gap: 5px; flex: none;
    min-height: 36px; padding: 0 14px; border-radius: 999px; font-size: 13px; font-weight: 560;
    cursor: pointer; white-space: nowrap; font-family: inherit;
    border: 1px solid var(--border); background: var(--surface); color: var(--text-2);
  }
  .filter-pill.is-active { border-color: transparent; background: var(--text); color: #fff; }
  .filter-pill-new { border-style: dashed; color: var(--accent); }
  .library-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px;
    margin: 2px 0 12px; }
  .sort-select {
    font: inherit; font-size: 13px; font-weight: 560; color: var(--text);
    background: var(--surface); border: 1px solid var(--border); border-radius: 999px;
    min-height: 34px; padding: 0 10px; cursor: pointer;
  }
  .chip-collection { background: var(--accent-weak); color: var(--accent); }

  /* Collection picker in the save sheets: toggle chips plus "New collection". */
  .collection-picker { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }
  .chip-toggle {
    display: inline-flex; align-items: center; gap: 5px; min-height: 34px; padding: 0 12px;
    border-radius: 999px; font: inherit; font-size: 13px; font-weight: 560; cursor: pointer;
    border: 1px solid var(--border); background: var(--surface); color: var(--text-2);
  }
  .chip-toggle[aria-pressed="true"] { background: var(--accent-weak); border-color: var(--accent); color: var(--accent); }
  .chip-toggle.chip-new { border-style: dashed; color: var(--accent); }
  .chip-new-form { display: inline-flex; gap: 6px; align-items: center; }

  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;
  }

  /* ----------------------------------------------------------------
     User guide
     Long-form prose inside a 430px shell: readable measure, generous
     line height, and no horizontal overflow at 320px (PRD §73).
     ---------------------------------------------------------------- */

  .guide-search-wrap { position: sticky; top: 0; z-index: 10; padding: 6px 0 10px;
    background: linear-gradient(var(--bg) 72%, rgba(245,246,242,0)); }
  .guide-search {
    display: flex; align-items: center; gap: 9px;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 0 12px; min-height: 46px;
    color: var(--text-2); box-sizing: border-box;
  }
  .guide-search:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-weak); }
  .guide-search input {
    flex: 1; min-width: 0; border: 0; outline: 0; background: transparent;
    font-size: 15px; color: var(--text); font-family: inherit; min-height: 44px;
  }
  .guide-search input::-webkit-search-cancel-button { display: none; }
  .guide-clear {
    border: 0; background: var(--surface-2, #eef0e9); color: var(--text-2);
    width: 30px; height: 30px; border-radius: 999px; display: flex;
    align-items: center; justify-content: center; cursor: pointer; flex: none;
  }
  .guide-hint { font-size: 12px; color: var(--text-3); margin: 8px 2px 0; line-height: 1.5; }

  .guide-results { display: flex; flex-direction: column; gap: 9px; }
  .guide-result {
    text-align: left; padding: 13px 14px; cursor: pointer; font-family: inherit;
    display: flex; flex-direction: column; gap: 5px; min-height: 44px;
  }
  .guide-result:active { transform: scale(0.995); }
  .guide-result-title { font-size: 14.5px; font-weight: 620; color: var(--text); }
  .guide-result-snippet { font-size: 13px; color: var(--text-2); line-height: 1.55; }
  .guide-result mark, .guide-section mark {
    background: #fff2b8; color: inherit; border-radius: 3px; padding: 0 2px;
  }
  .guide-no-results { padding: 16px; }

  .guide-toc { padding: 6px 0; overflow: hidden; }
  .guide-toc-title {
    font-size: 12px; font-weight: 640; color: var(--text-2); text-transform: uppercase;
    letter-spacing: .05em; margin: 10px 14px 6px;
  }
  .guide-toc-item {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    width: 100%; border: 0; background: transparent; cursor: pointer;
    padding: 12px 14px; min-height: 46px; font-family: inherit;
    font-size: 14.5px; color: var(--text); text-align: left;
  }
  .guide-toc-item + .guide-toc-item { border-top: 1px solid var(--border); }
  .guide-toc-item:active { background: var(--surface-2, #eef0e9); }
  .guide-toc-item svg { color: var(--text-3); flex: none; }

  .guide-section {
    margin-top: 26px; padding-top: 4px; scroll-margin-top: 76px;
    border-radius: 12px; transition: background-color .5s ease;
  }
  .guide-section.guide-flash { background: var(--accent-weak); }
  .guide-h2 {
    font-size: 18px; font-weight: 640; letter-spacing: -0.01em;
    margin: 0 0 10px; scroll-margin-top: 76px;
  }
  .guide-section p { font-size: 14px; line-height: 1.68; color: var(--text-2); margin: 0 0 11px; }
  .guide-section strong { color: var(--text); font-weight: 620; }
  .guide-section ul, .guide-section ol {
    margin: 0 0 12px; padding-left: 20px; font-size: 14px;
    line-height: 1.68; color: var(--text-2);
  }
  .guide-section li { margin-bottom: 6px; }
  .guide-section li::marker { color: var(--text-3); }
  .guide-section code {
    font-size: 12.5px; background: var(--surface-2, #eef0e9); padding: 1px 5px;
    border-radius: 5px; font-family: var(--font-mono);
  }
  .guide-note {
    background: var(--surface); border: 1px solid var(--border);
    border-left: 3px solid var(--accent); border-radius: 10px;
    padding: 12px 14px; font-size: 13.5px; line-height: 1.62; color: var(--text-2);
    margin: 0 0 12px; box-sizing: border-box;
  }
  .guide-note strong { color: var(--text); }

  .guide-top {
    border: 0; background: transparent; color: var(--text-3); cursor: pointer;
    font-family: inherit; font-size: 12.5px; padding: 4px 2px 0; min-height: 32px;
    display: inline-flex; align-items: center; gap: 4px;
  }
  .guide-footer-note {
    font-size: 12.5px; color: var(--text-3); line-height: 1.62;
    margin: 28px 0 0; padding-top: 16px; border-top: 1px solid var(--border);
  }
  .guide-inline-link {
    border: 0; background: transparent; color: var(--accent); cursor: pointer;
    font-family: inherit; font-size: 12.5px; padding: 0; text-decoration: underline;
  }

  /* App footer: persistent route into the guide and the footer surfaces. */
  .app-footer {
    margin-top: 26px; padding: 16px 0 4px; border-top: 1px solid var(--border);
    display: flex; flex-wrap: wrap; align-items: center; justify-content: center;
    gap: 6px 14px;
  }
  .app-footer button {
    border: 0; background: transparent; color: var(--text-2); cursor: pointer;
    font-family: inherit; font-size: 12.5px; padding: 8px 2px; min-height: 40px;
    display: inline-flex; align-items: center; gap: 5px;
  }
  .app-footer button:hover { color: var(--text); }
  .app-footer .footer-copy {
    flex-basis: 100%; text-align: center; font-size: 11.5px; color: var(--text-3);
    line-height: 1.6;
  }

  /* ---------------------------------------------------------------
     Responsive breakpoints
     --------------------------------------------------------------- */

  /* Tablet — bounded, centred column; denser grids; no rail yet. */
  @media (min-width: 768px) {
    :root {
      --content-max: 720px;
      --content-pad: 24px;
    }
    .thumbs { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .stats { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .preview-frame { height: 560px; }
    .toast-host { max-width: 520px; }
    /* Keep the bottom bar centred over the content column, rounded so it
       reads as a dock rather than a phone edge. */
    .bottom-nav {
      max-width: min(600px, calc(100% - 48px));
      border-radius: 16px 16px 0 0;
      border-left: 1px solid var(--border);
      border-right: 1px solid var(--border);
    }
    .app-footer { max-width: var(--content-max); margin-left: auto; margin-right: auto; }
  }

  /* Brand URL treatment: monospace, with each "/" in Volt Deep. */
  .brand-url { font-family: var(--font-mono); }
  .brand-url-slash { color: var(--accent); font-weight: 700; }

  /* Where the logo sits in the signed-in app. The rail lockup exists only on
     desktop (the rail is the bottom bar on smaller screens); the home-header
     lockup covers phones and tablets and steps aside once the rail shows it. */
  .rail-brand { display: none; }
  .home-brand { margin: 2px 0 14px; }

  /* The Workspace destination lives on the desktop rail; on phones and
     tablets the bottom bar keeps its five items and Profile links to it. */
  .nav-rail-only { display: none !important; }

  /* Profile picture with an upload badge. Pictures always fill a circle. */
  .avatar-edit { position: relative; border: 0; padding: 0; background: none; cursor: pointer; flex: none; border-radius: 999px; }
  .avatar-edit-badge {
    position: absolute; right: -2px; bottom: -2px; width: 22px; height: 22px; border-radius: 999px;
    background: var(--surface, #fff); border: 1px solid var(--border); color: var(--text-2);
    display: flex; align-items: center; justify-content: center;
  }
  img.avatar { object-fit: cover; }

  /* Desktop — persistent left rail replaces the bottom bar; wide content. */
  @media (min-width: 1024px) {
    :root {
      --nav-w: 232px;
      --content-max: 1040px;
      --content-pad: 32px;
      /* No bottom bar on desktop, so reclaim its reserved space. */
      --nav-h: 0px;
    }

    .bottom-nav {
      top: 0;
      bottom: 0;
      left: 0;
      right: auto;
      transform: none;
      width: var(--nav-w);
      max-width: var(--nav-w);
      height: 100vh;
      height: 100dvh;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      justify-content: flex-start;
      gap: 2px;
      padding: 18px 12px;
      border-top: 0;
      border-radius: 0;
      border-left: 0;
      border-right: 1px solid var(--border);
      overflow-y: auto;
    }
    .nav-item {
      flex-direction: row;
      justify-content: flex-start;
      gap: 12px;
      min-height: 44px;
      padding: 0 14px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 560;
    }
    .nav-item:hover { background: var(--surface-2); }
    .nav-item[aria-current="page"] { background: var(--accent-weak); color: var(--accent); }
    .nav-item svg { width: 18px; height: 18px; }
    /* The Add action becomes an inline labelled row, not a floating disc. */
    .nav-add {
      width: 26px;
      height: 26px;
      margin: 0;
      box-shadow: none;
    }
    .nav-add svg { width: 16px; height: 16px; }
    /* Ordering: the Add button sits mid-bar on mobile; on the rail it reads
       better last, after the four destinations. */
    .bottom-nav #nav-add { order: 9; }
    /* Clear space: the kit asks for X (the spark height, about 8 px at this size)
       on every side; the padding and margin here give several times that. */
    .rail-brand { display: block; order: -1; padding: 6px 14px 22px; }
    .home-brand { display: none; }
    .nav-rail-only { display: flex !important; order: 10; margin-top: auto; }
    /* Active workspace: under the logo, above Home. Opens its settings. */
    .rail-workspace {
      order: -1; margin: 0 0 14px !important; align-items: center; gap: 10px;
      min-height: 52px; padding: 8px 10px; border-radius: 12px;
      border: 1px solid var(--border); background: var(--surface, #fff);
      color: var(--text); text-align: left; cursor: pointer; font: inherit;
    }
    .rail-workspace:hover { background: var(--surface-2); }
    .rail-workspace:focus-visible, .nav-item:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .rail-workspace-text { display: flex; flex-direction: column; min-width: 0; }
    .rail-workspace-name { font-size: 14px; font-weight: 620; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rail-workspace-kind { font-size: 12px; color: var(--text-2); }
    /* Log out sits last, directly under Workspace. */
    .rail-logout { order: 11; margin-top: 0 !important; color: var(--text-2); }
    .rail-logout:hover { color: var(--danger); }
    .nav-mobile-only { display: none; }

    .app-main { padding-bottom: 56px; }
    .app-header { padding-top: 0; }
    .sheet { max-width: 560px; }

    /* Two-column reading layout for the artifact detail screen, where there
       is genuinely independent content to place side by side. */
    .detail-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
      gap: 18px;
      align-items: start;
    }
    .detail-grid > * { margin-top: 0 !important; }
  }

  /* Wide desktop — more column for dense views, more tiles per row. */
  @media (min-width: 1440px) {
    :root { --content-max: 1200px; }
    .thumbs { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  }

  /* Touch devices keep chunky targets regardless of width. */
  @media (hover: none) {
    .nav-item { min-height: 48px; }
  }

  /* Respect reduced-motion preferences (PRD §113) */
  @media (prefers-reduced-motion: reduce) {
    * { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; }
  }
`

export async function renderShell(c: Context<AppEnv>, options: ShellOptions): Promise<Response> {
  const hasShareCookie = !!readShareGrantCookie(c)

  const boot = {
    route: options.route,
    artifactId: options.artifactId ?? null,
    shareToken: options.shareToken ?? null,
    initialData: options.initialData ?? null,
    hasShareGrant: hasShareCookie,
    authenticated: !!c.get('principal')?.userId
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=5">
<meta name="theme-color" content="#12151c">
<meta name="color-scheme" content="light">
<meta name="description" content="One secure library for everything you and your AI create.">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="robots" content="noindex, nofollow">
<title>Artifactry</title>
<!--
  Official icon set from the Artifactry logo kit, served as ordinary static
  assets under /static/brand/. The generated _routes.json already excludes
  /static/*, so these need no routing change and are served by Pages without
  touching the Worker.
-->
<link rel="icon" href="/static/brand/favicon.ico" sizes="48x48">
<link rel="icon" href="/static/brand/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/static/brand/apple-touch-icon.png">
<link rel="manifest" href="/static/brand/site.webmanifest">
<!--
  Brand typefaces: Inter (UI text) and JetBrains Mono (code, IDs, URLs).
  display=swap keeps text visible on the system fallback while they load.
-->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400..700&family=JetBrains+Mono:wght@400..700&display=swap">
<style>${DESIGN_TOKENS}</style>
<script src="https://cdn.tailwindcss.com"></script>
<script>
  // Tailwind is used for layout utilities only; the palette above stays the
  // single source of truth so the preview iframe and share page match.
  if (window.tailwind) {
    tailwind.config = {
      corePlugins: { preflight: false },
      theme: { extend: {
        colors: {
          ink: '#12151c', muted: '#5a6066', faint: '#7e858b',
          line: '#e2e4da', accent: '#4e7a00', volt: '#b8f23a', paper: '#f5f6f2'
        },
        borderRadius: { card: '14px' }
      } }
    }
  }
</script>
</head>
<body>
<div id="shell" role="application" aria-label="Artifactry">
  <noscript>
    <div style="padding:24px;text-align:center">
      <h1 style="font-size:20px">JavaScript required</h1>
      <p style="color:#5a6066">Artifactry is an interactive application. Please enable JavaScript.</p>
    </div>
  </noscript>
  <div id="app" aria-live="polite"></div>
</div>
<div id="sheet-host"></div>
<div id="toast-host" class="toast-host" aria-live="assertive" aria-atomic="false"></div>
<script id="boot-data" type="application/json">${serializeBoot(boot)}</script>
<script type="module" src="/static/app.js"></script>
</body>
</html>`

  return c.html(html)
}
