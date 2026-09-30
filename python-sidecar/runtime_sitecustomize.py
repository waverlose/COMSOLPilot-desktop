"""Expose the installed writable core to embedded Python processes."""
import os
import sys

core = os.environ.get("COMSOLPILOT_CORE", "")
if core and os.path.isfile(os.path.join(core, "src", "server.py")):
    sys.path.insert(0, core)
