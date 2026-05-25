from pydantic import BaseModel, Field


class RoomCreate(BaseModel):
    timezone: str = "Asia/Seoul"
    max_participants: int = Field(default=20, ge=2, le=100)
