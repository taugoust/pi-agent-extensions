import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
for file in root.rglob('*.ts'):
    text = file.read_text()

    def resolve_import(match):
        target = match.group(2)
        ts_target = target[:-3] + '.ts'
        if (file.parent / ts_target).exists():
            return match.group(1) + ts_target + match.group(3)
        return match.group(0)

    file.write_text(re.sub(r"(from\s+[\"'])(\.[^\"']+\.js)([\"'])", resolve_import, text))
