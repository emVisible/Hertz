"""输入校验（AXIOM §8.1 快速失败）：路由层统一字段上限与枚举白名单。

后端独立校验，不依赖前端。长度上限集中在数据库列宽的合理安全值内。
"""

from pydantic import BaseModel, Field

MAX_NAME = 255
MAX_DESC = 4000
MAX_METHOD = 4000
MAX_TOPIC = 10_000
MAX_URL = 2048


class PlanBody(BaseModel):
    name: str = Field(min_length=1, max_length=MAX_NAME)
    description: str = Field(default="", max_length=MAX_DESC)
    mode: str = Field(default="text", pattern="^(text|visual|video)$")
    phase_order: list | None = None
    crew_id: str | None = None
    brief_id: str | None = None
    buff_keys: list[str] | None = None


class PlanUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=MAX_NAME)
    description: str | None = Field(default=None, max_length=MAX_DESC)
    mode: str | None = Field(default=None, pattern="^(text|visual|video)$")
    phase_order: list | None = None
    crew_id: str | None = None
    brief_id: str | None = None
    buff_keys: list[str] | None = None


class RunBody(BaseModel):
    input: str = Field(default="", max_length=MAX_TOPIC)
    buff_keys: list[str] | None = None  # 运行时 buff 覆盖（空则用计划配置）


class CrewBody(BaseModel):
    name: str = Field(min_length=1, max_length=MAX_NAME)
    description: str = Field(default="", max_length=MAX_DESC)
    agents: list | None = None


class CrewUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=MAX_NAME)
    description: str | None = Field(default=None, max_length=MAX_DESC)
    agents: list | None = None


class BriefBody(BaseModel):
    name: str = Field(min_length=1, max_length=MAX_NAME)
    content: str = Field(default="", max_length=MAX_DESC * 10)
    platform_id: str = Field(default="", max_length=64)
    config: dict | None = None


class BriefUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=MAX_NAME)
    content: str | None = Field(default=None, max_length=MAX_DESC * 10)
    platform_id: str | None = Field(default=None, max_length=64)
    config: dict | None = None
