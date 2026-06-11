--[[
  Genesis Big Ben Bridge -- Lightroom Classic plugin (scaffold).

  Minimal plugin manifest that registers one Library menu action. Lightroom Classic
  plugins run in-process (Lua), so there is no network bridge/port -- Big Ben drives this
  via the file the action writes. Deploy: copy the whole `genesis-bridge.lrplugin` folder
  to the LrC plugins dir and enable it in File > Plug-in Manager (see ../README.md).
]]
return {
  LrSdkVersion = 10.0,
  LrSdkMinimumVersion = 6.0,

  LrToolkitIdentifier = 'net.genesis.bigben.bridge',
  LrPluginName = 'Genesis Big Ben Bridge',

  LrLibraryMenuItems = {
    {
      title = 'Genesis: Export Selection Paths',
      file = 'ExportSelectionInfo.lua',
    },
  },

  VERSION = { major = 0, minor = 1, revision = 0, build = 0 },
}
