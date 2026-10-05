# Architecture

Twenty-seven capability packages extend DSH through public Cordis services, configuration edits and client slots. Eight support libraries own shared configuration/lifecycle, protocol translation, media execution and evidence behavior. Upstream DSH remains an unchanged reference. Dependencies follow demonstrated consumers; support libraries are not activated as separate bundles.

## Configuration and ownership

plugin-runtime exposes a complete configuration as a root volatile value. An accepted revision-fenced mutation disposes the previous child fiber before replacing its capabilities. Native settings snapshots are frozen; the domain validator receives a clone. Each child owns its adapters, commands, network cancellation, workers and cleanup.

Browser forms use configForms and settingsSchema, register in the Plugins page, and receive safe values only. A blank secret retains the stored value; clearing is explicit. Native remote descriptors expose bounded account, login, media and evidence views. Each authorization attempt belongs to the admitted peer and cancels on disconnect or disposal. Account grants and keys stay on the host.

Generated settings forms are suppressed through the public presentation API. DSH rc.2's diagnostic Built-in plugins inventory remains visible because it has no public per-plugin exclusion API.

## Providers and media

openai-wire handles neutral requests and streaming protocol state. llm-openai-compat adapts native DSH messages, images, tool dependencies and cancellation to chat completions. Provider packages own credential generations, discovered metadata and routing. OpenRouter's Plugins and composer selectors mutate the same per-model preference; model pins override global pins while privacy constraints remain enforced.

Media descriptions retain execution protocol, input/output JSON schemas, named/repeated assets, freshness and unsupported-mode evidence. media-gen shares these contracts between configuration controls, metadata tools, validation and skills. fal's public model API supplies discovery; schemas and prices are fetched on demand on the host. Audio synthesis, transcription and asynchronous video remain separate OpenRouter protocols even when output modalities overlap.

Media execution has aggregate byte/file/deadline bounds and scoped filesystem publication. Failed publication rolls back only files still owned by that operation. Native attachment promotion uses the admitted execution world and immutable attachment store. Result-owned download and rollback functions are never serialized into model-visible JSON.

Public downloads require credential-free HTTPS, validate all DNS answers, pin a public address while preserving TLS identity, and refuse redirects. Protected video downloads use a capability restricted to the returned job's content URLs. fal queue cancellation uses its documented job endpoint. OpenRouter local cancellation reports the submitted identity without claiming to cancel remote inference; its public video contract does not establish remote cancellation or per-request routing/privacy enforcement. Incompatible preferences fail before dispatch.

## Evidence assembly

evidence-store owns immutable originals, workspace-local deduplication, original-span FTS, versioned source-linked atoms, self-contained manifests and independent cold-object compression. One SQLite 3.53.4 worker owns each database with WAL/FULL durability. Queue sizes, event payloads, workspace/session admission, compression and retention are bounded. Deletion invalidates dependent atoms/manifests; recovery removes deleted historical checkpoint content. Reclamation preserves shared live objects.

evidence-harness captures authored native observations while excluding generated checkpoints and replacement copies. It preserves UTF-8 spans, source roles, qualifiers, exact controls and tool-call dependencies. Extraction uses a prepared provider call, no tools, a bounded output, explicit spending reservations and a final egress recheck. Credentials belong to the selected provider.

The compactor installs replacements into standard/PTC through the public configuration editor. It preserves unrelated rows and removes competing stock compaction/pruning/offload entries. A native request guard persists the selected surface, then lets DSH rebuild its frozen request. Canonical replay retains request headers and tool definitions with hash/source validation. Native image costs complement explicitly labeled heuristic envelope estimates; universal exact provider serialization/tokenization is not exposed by rc.2.

The assembly analogy is reusable components and explicit construction dependencies: originals → spans → atoms → request manifests. It is not a claim to compute Assembly Theory's physical assembly index or optimal compression.

## Qualification boundaries

Source tests use generated aliases into a clean pinned DSH checkout. Published artifacts are compiled ESM, declarations, browser factories, workers, locales and licenses, with third-party notices for bundled browser code. Independent consumers and an actual registry-installed DSH web profile exercise tarballs without source aliases. Complete standard/PTC replacements and controlled native agent turns are checked after restart.

The qualification audit records browser/live-provider results, outstanding gates. Small synthetic continuation decisions do not establish production task-completion quality. Neither test success nor artifact preparation authorizes publication.
