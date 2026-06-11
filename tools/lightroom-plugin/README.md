# Genesis Big Ben Bridge — Lightroom Classic plugin

Minimal LrC plugin scaffold for the Big Ben content pipeline. LrC plugins run in-process
(Lua) — there is no network port; the bridge is file-based (the action writes a file that
WSL reads).

## Contents
- `genesis-bridge.lrplugin/Info.lua` — plugin manifest; registers one Library menu item.
- `genesis-bridge.lrplugin/ExportSelectionInfo.lua` — example action: writes the selected
  photos' file paths to `~/Documents/genesis-bigben-selection.txt`.

## Deploy (Dominik, on Windows)
1. Copy the whole `genesis-bridge.lrplugin` folder into the LrC plugins directory:
   `%USERPROFILE%\Documents\Adobe\Lightroom\Plugins\`
   (create `Plugins` if it does not exist).
2. In Lightroom Classic: **File → Plug-in Manager → Add**, select the
   `genesis-bridge.lrplugin` folder, then **Done**.
3. Use it: select photos in the Library, then **Library menu → Genesis: Export Selection
   Paths**. A dialog confirms the output file; Big Ben reads it from the Windows Documents
   path (reachable from WSL at `/mnt/c/Users/<user>/Documents/genesis-bigben-selection.txt`).

## Extend
Add real pipeline steps inside `ExportSelectionInfo.lua` (or new action files registered in
`Info.lua`): apply develop presets, run an export with a preset, write richer JSON metadata.
Keep each action small and explicit.
