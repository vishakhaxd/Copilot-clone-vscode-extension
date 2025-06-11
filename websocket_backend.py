#!/usr/bin/env python3
"""
Minimal WebSocket Backend Server for DSP Cipher VS Code Extension
"""

import asyncio
import websockets
import json
import logging

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class SimpleServer:
    def __init__(self):
        self.clients = set()
        
    async def handle_client(self, websocket):
        """Handle a VS Code client connection"""
        self.clients.add(websocket)
        
        try:
            async for message in websocket:
                try:
                    data = json.loads(message)
                    logger.info(f"Received: {data.get('type')}")
                    
                    # Route message based on type parameter
                    message_type = data.get('type')
                    if message_type == 'chat_message':
                        await self.handle_chat_message(websocket, data)
                    elif message_type == 'client_register':
                        await self.handle_client_register(websocket, data)
                    elif message_type == 'clear_chat':
                        await self.handle_clear_chat(websocket, data)
                    else:
                        logger.warning(f"Unknown message type: {message_type}")
                        
                except json.JSONDecodeError:
                    logger.error("Invalid JSON received")
        except websockets.exceptions.ConnectionClosed:
            logger.info("VS Code disconnected")
        finally:
            self.clients.discard(websocket)

    async def handle_chat_message(self, websocket, data):
        """Handle chat_message type - send dummy response"""
        try:
            await websocket.send(json.dumps({
                "type": "chat_message",
                "message": "from chat message"
            }))
            logger.info("Sent: from chat message")
        except Exception as e:
            logger.error(f"Error sending chat message response: {e}")
    
    async def handle_client_register(self, websocket, data):
        """Handle client_register type - just print message"""
        logger.info("client reg")
    
    async def handle_clear_chat(self, websocket, data):
        """Handle clear_chat type - just print message"""
        logger.info("clear_chat")

server = SimpleServer()

async def main():
    """Start the server"""
    logger.info("Starting minimal WebSocket server...")
    
    # Start WebSocket server
    await websockets.serve(server.handle_client, "127.0.0.1", 7778)
    logger.info("✅ Server running on ws://127.0.0.1:7778")
    
    # Keep running forever
    await asyncio.Future()  # Run forever

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Server stopped by user")
