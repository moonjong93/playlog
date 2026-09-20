"""파이프라인이 주고받는 값 객체."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Item:
    id: int
    source_id: int
    source_name: str
    source_kind: str
    source_weight: float
    url: str
    title: str
    description: str
    content: str
    published_at: str | None
    fetched_at: str
    vec: list[float]

    @property
    def desc_len(self) -> int:
        return len(self.description or "")


@dataclass
class Hit:
    item: Item
    similarity: float
    role: str  # seed | retrieved | community


@dataclass
class Cluster:
    seeds: list[Item]
    centroid: list[float]
    retrieved: list[Hit] = field(default_factory=list)
    community: list[Hit] = field(default_factory=list)

    @property
    def seed_ids(self) -> set[int]:
        return {s.id for s in self.seeds}


@dataclass
class StoryRow:
    id: int
    slug: str | None
    status: str
    skip_reason: str | None
    centroid: list[float]
    source_count: int
    community_count: int


@dataclass
class Prepared:
    cluster: Cluster
    decision: str              # write | skip | merge
    skip_reason: str | None
    existing: StoryRow | None
    relation: str | None       # followup | related | None
    relation_score: float
    importance: float
