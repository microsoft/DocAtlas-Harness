# ADR-030: Extension execution and approved resource snapshots

> Status: Internal Linux implementation; no public release acceptance
> Date: 2026-09-08

Route official pi.exec through a loader-scoped backend before extension factories execute, retaining its argv (no shell),
cwd, separate stdout/stderr, code/killed, timeout and abort semantics. Default unconfigured SDK behavior remains native.
Do not install a process-global override or substitute a different extension API. Cached factories must receive the
current runtime/backend; stale instances remain fenced by native assertActive.

Resource approval is about reviewed bytes, not mutable path names. Capture explicitly selected local resource trees
into bounded, hashed, immutable snapshots; reject traversal/symlinks/special files and changes during capture. Approval
binds actor/workspace and the manifest hash. A changed source tree needs a new snapshot/approval; the executing worker
cannot mutate its approved code. Runtime/session state stays in separate writable locations. Preserve approved extensions,
skills/prompts/themes/context and their relative assets/imports; do not disable resource loading to obtain isolation.

This is an internal gate toward authenticated controls, not authorization for arbitrary browser paths, installation or
automatic trust of model-written project resources. Package dependency closure, project admission/UI, provider/network and
full controls remain separately verified requirements. Kernel isolation is retained even for trusted extension Node code.

The finite SDK delta adds a loader-scoped extensionExec port and a runtime exec field. The previous 20 patched files are
preserved; four additional dist files are fingerprinted in compatibility revision v2. The native fallback remains unchanged
when the option is absent. Loading cached factories still creates and binds a fresh runtime, including pre-trust loading.

resource-trust.v1 freezes independent snapshot/approval fields. ResourceStore uses fd-relative Linux reads, O_NOFOLLOW,
32 MiB/512-file/depth/directory bounds, stable source rechecks, content-addressed snapshots, fsync/rename publication and
SQLite FULL transactions. Grants bind actor/workspace/reviewed hash/version. Native execution receives only approved RO
resource aliases, never the mutable original agent directory; transcript/control/credential state stays distinct. Revocation
fences new requests and stops the linked worker/effects. The private capture/approval APIs are not public routes.

Global resource snapshots preserve local relative files and approved skill/prompt/theme/extension assets. Arbitrary package
installation/dependency closure, project approval UI, state-writing extension migration, cross-process revocation delivery,
cross-platform capture and complete native/provider controls remain explicit gates; this is not blanket compatibility.

Cancellation testing found bwrap 0.4.0 installs PDEATHSIG late. Killing only its monitor early can orphan the namespace and
leave stdio open. LinuxExecutor now consumes bounded --info-fd metadata, validates the sandbox child/start-time identity,
terminates its PID namespace and then the monitor, and waits for actual close. Tests include 1/10/100ms early deadlines.
