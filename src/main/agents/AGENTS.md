# Agent bundle subsystem

- Bundles are data, never executable configuration. Reject unknown executable fields.
- Configs may reference relative Markdown instruction files beside their config. All other files,
  including unreferenced instructions, are rejected.
- Resolve and realpath every read inside the bundle. Symlinks and special files are rejected.
- Built-ins are immutable. Project bundles support bounded multi-file create/edit/delete and publish
  the fully validated directory atomically; delete whole bundles through OS trash.
- Discovery is streamed and capped before parsing. Diagnostics retain the actual file and YAML
  location, while native I/O failures cross IPC only as stable path-free errors.
- Renderer DTOs never include managed absolute paths or stored run snapshots.
