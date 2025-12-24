"""
WebSocket 連接管理器
避免循環導入問題
"""

from fastapi import WebSocket
import time
import json
from typing import List
from app.utils.logger import get_logger

logger = get_logger()


class ConnectionManager:
    """WebSocket 連接管理器"""
    
    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self.connection_heartbeat: dict[WebSocket, float] = {}

    async def connect(self, websocket: WebSocket):
        """接受新的 WebSocket 連接"""
        await websocket.accept()
        self.active_connections.append(websocket)
        self.connection_heartbeat[websocket] = time.time()
        logger.info("websocket_connected", total_connections=len(self.active_connections))

    async def disconnect(self, websocket: WebSocket):
        """斷開 WebSocket 連接"""
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        if websocket in self.connection_heartbeat:
            del self.connection_heartbeat[websocket]
        logger.info("websocket_disconnected", total_connections=len(self.active_connections))

    async def broadcast(self, message: str):
        """向所有連接廣播消息"""
        if not self.active_connections:
            logger.warning("websocket_broadcast_no_connections")
            return
            
        # 清理過期的連接
        await self._cleanup_stale_connections()
        
        # 發送消息到所有活躍連接
        for connection in self.active_connections.copy():
            try:
                await connection.send_text(message)
            except Exception as e:
                logger.error("websocket_send_failed", error=str(e))
                # 移除失敗的連接
                await self.disconnect(connection)

    async def _cleanup_stale_connections(self):
        """清理過期的連接"""
        current_time = time.time()
        stale_connections = []
        
        for ws, last_heartbeat in self.connection_heartbeat.items():
            if current_time - last_heartbeat > 30:  # 30秒超時
                stale_connections.append(ws)
        
        for ws in stale_connections:
            await self.disconnect(ws)
            logger.info("stale_connection_cleaned")


# 全局 WebSocket 管理器實例
manager = ConnectionManager()
