#target photoshop
/*
  Genesis Big Ben -- Photoshop Actions batch runner (scaffold).

  Plays a pre-recorded Photoshop Action over every image in an input folder and writes the
  result to an output folder. This is the "Actions path" -- it needs NO bridge port and NO
  UXP developer mode; Dominik only records the Action once (see the runbook). Big Ben (WSL)
  drives it by writing `photoshop-batch-config.json` next to this script (on a Windows-visible
  path) and launching:  Photoshop.exe -r <thisscript.jsx>

  Config (photoshop-batch-config.json, beside this file):
    {
      "inputFolder":  "C:\\Users\\me\\bigben\\in",
      "outputFolder": "C:\\Users\\me\\bigben\\out",
      "actionSet":    "Genesis",          // the Action Set (folder) name in Photoshop
      "actionName":   "WebExport",        // the Action name
      "jpegQuality":  10                   // 0-12; used when saving the result as JPEG
    }

  When it finishes it writes `photoshop-batch-done.json` beside the script so WSL can poll
  for completion. If the Action already saves/exports, set the Action to do so and ignore
  the JPEG save here.
*/
function readConfig(path) {
  var f = new File(path);
  if (!f.exists) { throw new Error('config not found: ' + path); }
  f.open('r');
  var txt = f.read();
  f.close();
  // Photoshop 2021+ has native JSON. Parse strictly and NEVER eval() the config text:
  // the config may be written by an automated (Big Ben) process, so eval would let
  // prompt-injected content execute arbitrary ExtendScript. A parse failure stops the run.
  try {
    return JSON.parse(txt);
  } catch (e) {
    throw new Error('config is not valid JSON (' + path + '): ' + e.toString());
  }
}

function saveJpeg(doc, outFile, quality) {
  var opt = new JPEGSaveOptions();
  opt.quality = (quality === undefined) ? 10 : quality;
  doc.saveAs(outFile, opt, true, Extension.LOWERCASE);
}

function main() {
  var here = new File($.fileName).parent;
  var cfg = readConfig(here.fsName + '/photoshop-batch-config.json');

  var input = new Folder(cfg.inputFolder);
  var output = new Folder(cfg.outputFolder);
  if (!input.exists) { throw new Error('inputFolder missing: ' + cfg.inputFolder); }
  if (!output.exists) { output.create(); }

  var files = input.getFiles(/\.(jpg|jpeg|png|tif|tiff|psd)$/i);
  var processed = 0;
  var errors = [];

  var prevDialogs = app.displayDialogs;
  app.displayDialogs = DialogModes.NO;   // headless: never block on a dialog

  for (var i = 0; i < files.length; i++) {
    if (!(files[i] instanceof File)) { continue; }
    try {
      var doc = app.open(files[i]);
      app.doAction(cfg.actionName, cfg.actionSet);
      var base = files[i].name.replace(/\.[^.]+$/, '');
      saveJpeg(doc, new File(output.fsName + '/' + base + '.jpg'), cfg.jpegQuality);
      doc.close(SaveOptions.DONOTSAVECHANGES);
      processed++;
    } catch (e) {
      errors.push(files[i].name + ': ' + e.toString());
    }
  }

  app.displayDialogs = prevDialogs;

  var marker = new File(here.fsName + '/photoshop-batch-done.json');
  marker.open('w');
  marker.write('{"ok":' + (errors.length === 0) + ',"processed":' + processed +
               ',"errors":' + errors.length + '}');
  marker.close();
}

main();
