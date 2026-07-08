# Nexus-LM Agent Coding Standards

You MUST follow these rules when writing ANY code for Nexus-LM. These rules are derived from the Obsidian plugin review bot's eslint-plugin-obsidianmd ruleset and project-specific constraints.

## A — Popout Window Compatibility

Use these instead of browser globals for popout window safety:

| Instead of | Use |
|-----------|-----|
| `document.querySelector(...)` | `(activeDocument ?? document).querySelector(...)` |
| `setTimeout(fn, 100)` | `window.setTimeout(fn, 100)` |
| `clearTimeout(id)` | `window.clearTimeout(id)` |

Import `activeDocument` from `obsidian` when needed.

## B — Absolute No `any` Types

This is the most important rule. The review bot flags 20+ variants of `any` misuse.

### B1 — Explicit Types Everywhere

Every function parameter, return type, variable, and property MUST have an explicit type. Never use `any`.

```ts
// ❌ WRONG
function process(data) { return data.result; }
const x: any = getThing();

// ✅ RIGHT
interface ProcessResult { result: string; }
function process(data: ProcessResult): string { return data.result; }
const x: ProcessResult = getThing() as ProcessResult;
```

### B2 — Single Type Assertion at Boundaries

When parsing external data (API responses, file reads, user input), assert the type ONCE at the entry boundary. Never access `.json` or parsed objects as `any`.

```ts
// ❌ WRONG
const resp = await requestUrl({...});
const x = resp.json.settings;  // unsafe member access on any

// ✅ RIGHT
interface APIResponse { settings: { theme: string }; }
const raw = await requestUrl({...});
const parsed = JSON.parse(raw.text) as APIResponse;
const theme = parsed.settings.theme;  // typed, safe
```

### B3 — Still Unsafe After Casting

If you cast `as SomeType` but `SomeType` itself contains `any` fields, member access is still unsafe. Make all nested types concrete.

```ts
// ❌ STILL WRONG
interface Loose { data: any; }
const x = raw as Loose;
x.data.name;  // unsafe member access on any

// ✅ RIGHT
interface Tight { data: { name: string }; }
const x = raw as Tight;
x.data.name;  // safe
```

### B4 — Unsafe Spread

Never spread a value typed as `any` into an array.

```ts
// ❌ WRONG
const arr = [...(someVar as any)];

// ✅ RIGHT
const arr = [...(someVar as string[])];
// or
const arr = Array.from(someVar as ArrayLike<string>);
```

### B5 — No Unnecessary Assertions

If a value is already typed as `T`, don't assert `as T`.

```ts
// ❌ WRONG
function greet(name: string): string {
  return `Hello ${name as string}`;  // name is already string
}

// ✅ RIGHT
function greet(name: string): string {
  return `Hello ${name}`;
}
```

## C — Promise Hygiene

Every promise must be handled. No exceptions.

```ts
// ✅ In async functions: await
await this.saveData(data);

// ✅ In non-async callbacks: void
button.onClick(() => { void this.saveData(data); });

// ✅ With .catch
this.saveData(data).catch((err: Error) => console.error('fail', err));

// ✅ With .then rejection handler
this.saveData(data).then(ok, (err: Error) => handle(err));

// ❌ WRONG — unhandled promise
this.saveData(data);
```

## D — No Dead Code

### D1 — No Empty Block Statements

```ts
// ❌ WRONG
try { await risky(); } catch (e) {}

// ✅ RIGHT — explain why empty
try { await risky(); } catch {
  // Non-critical, failure acceptable
}
// ✅ or remove try/catch entirely if nothing is caught
```

### D2 — No Unused Variables

```ts
// ❌ WRONG
catch (error) { /* error never used */ }

// ✅ RIGHT — omit binding when unused
catch { /* ignore */ }

// ❌ WRONG — unused parameter
items.forEach((item, index) => process(item)); // index unused
// ✅ RIGHT
items.forEach((item) => process(item));
```

## E — No Unnecessary try/catch Wrappers

Don't wrap code in try/catch if it can't throw, or if you re-throw without adding value.

```ts
// ❌ WRONG
try {
  return calculate(x);
} catch (e) {
  throw e;  // no value added
}

// ✅ RIGHT
return calculate(x);
```

## F — CSS Rules

### F1 — No `!important`

```css
/* ❌ WRONG */
.agent-step { color: red !important; }

/* ✅ RIGHT — use specificity or CSS variables */
.trace-container .agent-step { color: var(--text-accent); }
```

### F2 — All Styles in styles.css

- Never write `<style>` tags in `.svelte` files
- Never write inline styles (`style="..."` or `el.style.x = ...`)
- Every CSS class must be defined in `styles.css`

## G — Project-Specific Constraints

### G1 — No innerHTML/outerHTML

```ts
// ❌ WRONG
el.innerHTML = content;

// ✅ RIGHT — use Obsidian DOM API
el.createEl('div', { text: content });
el.setText(content);
el.createDiv({ cls: 'agent-content', attr: { 'data-value': id } });
```

### G2 — No Emojis in UI

Never use emoji characters in UI text. Use Lucide icons via `setIcon()`.

```ts
// ❌ WRONG
notice.setMessage('⚠️ Error occurred');
header.setText('📝 Note');

// ✅ RIGHT
import { setIcon } from 'obsidian';
setIcon(iconEl, 'alert-triangle');
notice.setMessage('Error occurred');
header.setText('Note');
const icon = header.createEl('span');
setIcon(icon, 'file-text');
```

### G3 — Available Lucide Icons Only

Use standard Lucide icons that ship with Obsidian. Common ones: `search`, `file-text`, `bot`, `brain`, `terminal`, `edit`, `eye`, `x`, `check`, `alert-triangle`, `settings`, `play`, `stop-circle`, `refresh-cw`, `folder`, `link`, `tag`, `list`.

---

## Pre-Submission Checklist

Before marking any file complete, verify:

- [ ] No `any` types used — every variable/param/return has a concrete type
- [ ] All promises handled (await, .catch, or void)
- [ ] No empty blocks or unused variables
- [ ] `window.setTimeout` / `window.clearTimeout` / `activeDocument` used where relevant
- [ ] No `innerHTML` / `outerHTML`
- [ ] No emoji characters in UI text
- [ ] All CSS classes reference `styles.css` — no inline styles, no `<style>` in Svelte
- [ ] No `!important` in any CSS
