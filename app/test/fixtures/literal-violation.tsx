// Fixture for the §9.6 literal-gate self-test: intentionally contains forbidden hardcoded copy
// (a JSX text literal AND a flagged-prop string literal). The gate must flag this → exit 1.
export function LiteralViolation() {
  return (
    <button title="Click me" aria-label="Submit the form">
      Hello world
    </button>
  );
}
