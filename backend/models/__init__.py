"""ORM model package — import all models so Alembic autogenerate sees them."""

from backend.models.ai_registry import (
    AICall,
    AIModel,
    AIPromptTemplate,
    AIProvider,
    ModelCapability,
    ModelRole,
)
from backend.models.base import Base, BaseModel
from backend.models.brief import Brief
from backend.models.buff import Buff
from backend.models.channel import Channel
from backend.models.crew import Crew
from backend.models.download import DownloadStatus, DownloadTask, Project
from backend.models.item import Item, ItemStatus, ItemType
from backend.models.monoline import (
    MonolineArtifact,
    MonolineBrand,
    MonolineEvent,
    MonolineJob,
    MonolineJobStage,
    MonolineJobStatus,
    MonolinePreset,
    MonolineScenePlan,
    MonolineSegment,
    MonolineStageStatus,
)
from backend.models.phase import PhaseStore
from backend.models.pipeline import ChannelInsight, SourceState
from backend.models.plan import (
    PhaseRun,
    PhaseRunStatus,
    Plan,
    PlanMode,
    WorkflowRun,
    WorkflowRunStatus,
)
from backend.models.role import Role
from backend.models.system import JobRun, JobStatus

__all__ = [
    "AICall",
    "AIModel",
    "AIPromptTemplate",
    "AIProvider",
    "Base",
    "BaseModel",
    "Brief",
    "Buff",
    "Crew",
    "DownloadStatus",
    "DownloadTask",
    "Item",
    "ItemStatus",
    "Channel",
    "ChannelInsight",
    "ItemType",
    "JobRun",
    "JobStatus",
    "TelegramNotification",
    "ModelCapability",
    "ModelRole",
    "MonolineArtifact",
    "MonolineBrand",
    "MonolineEvent",
    "MonolineJob",
    "MonolineJobStage",
    "MonolineJobStatus",
    "MonolinePreset",
    "MonolineScenePlan",
    "MonolineSegment",
    "MonolineStageStatus",
    "PhaseStore",
    "PhaseRun",
    "PhaseRunStatus",
    "Plan",
    "PlanMode",
    "Project",
    "Role",
    "SourceState",
    "WorkflowRun",
    "WorkflowRunStatus",
]
