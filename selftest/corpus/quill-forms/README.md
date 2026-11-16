# quill-forms

An invented set of source forms that the caller decision scanner reads. It has no backend.
`selftest/caller-decision-scanner.test.js` copies this directory, runs `extract` over the
copy, and reads the web and mobile `branch_point` facts it writes.

| File | What it holds |
|---|---|
| `web/src/forms/ScannerForms.ts` | One method per form: a regex literal after the head of an `if`, `while`, `for` and `with`, division after a parenthesized operand, optional method members in a type literal, an interface, a class body and a type argument, the same members in a generic interface or class, after a generic `extends` clause, after a type parameter with an object type or a function type in its constraint or default, and after an `extends` clause that calls a mixin, three spellings of one ternary, and unbraced nested `if` statements with `else`. It also holds optional members in a type after `as`, `satisfies`, `keyof`, `readonly` and `is`, each in a tight and a spaced spelling, and in four type places the scanner does not read: an arrow return type, a tuple, an angle-bracket assertion and a type parameter default. Further methods hold `?(` groups with and without a call, a block after a plain name `is` or `as`, and an `else` in a comment. |
| `mobile/src/app/features/forms/scanner-forms.service.ts` | The same class body as the web file, in an `@Injectable` class. |
| `web/src/forms/BadgeRow.tsx` | A ternary and a `&&` chain whose right operand is a JSX element over three lines, without and with parentheses. |

The tests find each line by its text, so a form can move inside its file.
