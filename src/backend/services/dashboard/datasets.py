"""Baltimore Bird - Catalogue of the datasets an analysis can run on.

For now every dataset is synthetic: a JSON document under ``data/default/datasets`` holding a
synthetic source configuration (see :mod:`.synthetic`) plus a name and a description. Datasets
are presented like files, so the run workflow (pick an analysis, pick data, read the report)
is the one real files will use later.

Signal resolution is exact by name. The signal dictionary and its aliases come later.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from .inputs import DatasetBinding, DeclaredSignal
from .synthetic import SyntheticSignal, parse_source_config

logger = logging.getLogger(__name__)

DATASET_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
MAX_DATASET_FILE_SIZE = 256 * 1024


@dataclass(frozen=True)
class Dataset:
    """A dataset an analysis can run on.

    Attributes:
        id: Stable identifier (file stem).
        name: Display name.
        description: Free text shown in the run screen.
        config: Validated synthetic source configuration (raw dict form).
        signals: Signal definitions, in file order.
        content_hash: sha256 of the canonical configuration, recorded in report provenance.
    """

    id: str
    name: str
    description: str
    config: Dict[str, Any]
    signals: tuple
    content_hash: str

    def summary(self) -> Dict[str, Any]:
        """Public description, without generator parameters."""
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "kind": "synthetic",
            "samples": int(self.config["samples"]),
            "period": float(self.config["period"]),
            "signals": [{"name": s.name, "unit": s.unit} for s in self.signals],
            "hash": self.content_hash,
        }


@dataclass
class Resolution:
    """How the declared signals of an analysis map onto one dataset.

    Attributes:
        dataset_id: Dataset the resolution applies to.
        matched: Declared name to dataset signal name.
        missing: Declared names absent from the dataset.
        unit_mismatches: Declared names whose dataset unit differs from the declared one.
    """

    dataset_id: str
    matched: Dict[str, str] = field(default_factory=dict)
    missing: List[str] = field(default_factory=list)
    unit_mismatches: List[Dict[str, str]] = field(default_factory=list)

    @property
    def complete(self) -> bool:
        """True when every declared signal was found."""
        return not self.missing

    def as_dict(self) -> Dict[str, Any]:
        """JSON form, for the API and report provenance."""
        return {
            "dataset_id": self.dataset_id,
            "matched": dict(self.matched),
            "missing": list(self.missing),
            "unit_mismatches": list(self.unit_mismatches),
            "complete": self.complete,
        }


def _load(path: Path) -> Optional[Dataset]:
    stem = path.stem
    if not DATASET_ID_PATTERN.match(stem):
        logger.warning("Dataset ignored, invalid identifier: %s", path.name)
        return None
    try:
        if path.stat().st_size > MAX_DATASET_FILE_SIZE:
            logger.warning("Dataset ignored, file too large: %s", path.name)
            return None
        raw = json.loads(path.read_text(encoding="utf-8"))
        config = {key: raw[key] for key in ("samples", "period", "seed", "signals")}
        parsed = parse_source_config(config)
    except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        logger.warning("Dataset ignored, unreadable %s: %s", path.name, exc)
        return None
    canonical = json.dumps(config, sort_keys=True, separators=(",", ":"))
    return Dataset(
        id=stem,
        name=str(raw.get("name") or stem),
        description=str(raw.get("description") or ""),
        config=config,
        signals=parsed.signals,
        content_hash=hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
    )


def list_datasets(directory: Path) -> List[Dataset]:
    """Load every valid dataset of a directory, sorted by name.

    Args:
        directory: Catalogue directory.

    Returns:
        Valid datasets; unreadable files are logged and skipped.
    """
    if not directory.is_dir():
        return []
    datasets = [ds for ds in (_load(path) for path in sorted(directory.glob("*.json"))) if ds]
    return sorted(datasets, key=lambda ds: ds.name.lower())


def get_dataset(directory: Path, dataset_id: str) -> Optional[Dataset]:
    """Load one dataset by identifier.

    Args:
        directory: Catalogue directory.
        dataset_id: Requested identifier; anything outside the identifier pattern is refused.

    Returns:
        The dataset, or None when unknown or invalid.
    """
    if not isinstance(dataset_id, str) or not DATASET_ID_PATTERN.match(dataset_id):
        return None
    path = directory / f"{dataset_id}.json"
    return _load(path) if path.is_file() else None


def resolve(declared: Sequence[DeclaredSignal], dataset: Dataset) -> Resolution:
    """Match declared signals onto a dataset by exact name.

    Args:
        declared: Signals the analysis needs.
        dataset: Candidate dataset.

    Returns:
        The resolution, listing matches, missing signals and unit mismatches.
    """
    by_name = {signal.name: signal for signal in dataset.signals}
    resolution = Resolution(dataset_id=dataset.id)
    for wanted in declared:
        found = by_name.get(wanted.name)
        if found is None:
            resolution.missing.append(wanted.name)
            continue
        resolution.matched[wanted.name] = found.name
        if wanted.unit and found.unit and wanted.unit != found.unit:
            resolution.unit_mismatches.append({"signal": wanted.name, "declared": wanted.unit, "found": found.unit})
    return resolution


def bind(declared: Sequence[DeclaredSignal], dataset: Dataset, resolution: Resolution) -> DatasetBinding:
    """Build the binding of a fully resolved dataset.

    Args:
        declared: Signals the analysis needs.
        dataset: Bound dataset.
        resolution: Its complete resolution.

    Returns:
        The binding, columns in declaration order.

    Raises:
        ValueError: If the resolution is incomplete.
    """
    if not resolution.complete:
        raise ValueError(f"dataset {dataset.id!r} lacks {', '.join(resolution.missing)}")
    by_name: Dict[str, SyntheticSignal] = {signal.name: signal for signal in dataset.signals}
    columns = tuple((wanted.name, by_name[resolution.matched[wanted.name]]) for wanted in declared)
    return DatasetBinding(
        dataset_id=dataset.id,
        samples=int(dataset.config["samples"]),
        period=float(dataset.config["period"]),
        seed=int(dataset.config["seed"]),
        columns=columns,
    )
