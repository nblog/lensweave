"""AI short-drama production platform — backend core.

Exposes the package version and nothing else at import time; submodules
(`config`, `db`, `models`, `services`, `api`, `cli`) are imported explicitly
by their consumers to keep import side effects local.
"""

__version__ = "0.1.0"
