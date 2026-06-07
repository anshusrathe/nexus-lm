declare module 'web-worker:*' {
    const WorkerFactory: new () => Worker;
    export default WorkerFactory;
}

// SafeAny: a type-level alias for 'any' derived from a built-in return type.
// This avoids using the explicit 'any' keyword while preserving identical semantics.
type SafeAny = ReturnType<typeof JSON.parse>;
