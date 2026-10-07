# Run inside FreeCAD (freecadcmd). Opens a STEP file the way the GUI importer
# does and prints one JSON line describing what FreeCAD sees.
#   COCAIDE_STEP=/path/part.step freecadcmd scripts/freecad_check.py
import json
import os

import FreeCAD
import Import
import Part

path = os.environ["COCAIDE_STEP"]
doc = FreeCAD.newDocument("cocaide_check")
Import.insert(path, doc.Name)
doc.recompute()
objects = [o for o in doc.Objects if hasattr(o, "Shape") and not o.Shape.isNull()]
shape = Part.read(path)
bb = shape.BoundBox
report = {
    "freecad": ".".join(FreeCAD.Version()[:3]),
    "file": path,
    "importedObjects": [o.Label for o in objects],
    "valid": shape.isValid(),
    "solids": len(shape.Solids),
    "faces": len(shape.Faces),
    "volume": shape.Volume,
    "area": shape.Area,
    "bbox": [bb.XMin, bb.YMin, bb.ZMin, bb.XMax, bb.YMax, bb.ZMax],
}
print("COCAIDE_FREECAD " + json.dumps(report))
