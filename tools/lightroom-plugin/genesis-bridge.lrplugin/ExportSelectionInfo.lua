--[[
  Example menu action for the Genesis Big Ben Bridge plugin.

  Writes the file paths of the currently selected (target) photos to a known file in the
  user's Documents folder, which Big Ben (WSL side) can then read. This is a minimal,
  real demonstration of the in-process bridge -- extend it with the metadata / export
  steps the pipeline actually needs (develop settings, export presets, etc.).
]]
local LrApplication = import 'LrApplication'
local LrTasks       = import 'LrTasks'
local LrPathUtils   = import 'LrPathUtils'
local LrDialogs     = import 'LrDialogs'

local OUTPUT_NAME = 'genesis-bigben-selection.txt'

LrTasks.startAsyncTask(function()
  local catalog = LrApplication.activeCatalog()
  local photos = catalog:getTargetPhotos()

  local paths = {}
  for _, photo in ipairs(photos) do
    paths[#paths + 1] = photo:getRawMetadata('path')
  end

  local outDir  = LrPathUtils.getStandardFilePath('documents')
  local outPath = LrPathUtils.child(outDir, OUTPUT_NAME)

  local file, err = io.open(outPath, 'w')
  if not file then
    LrDialogs.message('Genesis bridge', 'Could not write ' .. outPath .. ': ' .. tostring(err), 'critical')
    return
  end
  file:write(table.concat(paths, '\n'))
  if #paths > 0 then file:write('\n') end
  file:close()

  LrDialogs.message(
    'Genesis bridge',
    #photos .. ' photo path(s) written to:\n' .. outPath,
    'info'
  )
end)
