from pydantic import BaseModel, Field


class RoomCreate(BaseModel):
    timezone: str = "Asia/Seoul"
    max_participants: int = Field(default=20, ge=2, le=100)
    meeting_duration_minutes: int = Field(default=60, ge=30, le=480, multiple_of=30)
