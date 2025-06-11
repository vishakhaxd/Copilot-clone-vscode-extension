# WebSocket Bidirectional Communication Setup

This implementation adds bidirectional communication between your VS Code extension and the backend, allowing the backend to initiate conversations with users.

## Architecture

```
VS Code Extension ←→ WebSocket (Port 7778) ←→ Python Backend
                   ↕ HTTP Fallback (Port 7777) ↕
```

## Features Added

### 🚀 Backend-Initiated Messages
- **Proactive Questions**: Backend can ask users about their progress
- **Helpful Suggestions**: Contextual tips and recommendations  
- **Notifications**: Updates and alerts from the backend
- **Progress Monitoring**: Backend can track user activity

### 🔄 Robust Connection Management
- **Auto-reconnection**: Automatically reconnects if connection drops
- **HTTP Fallback**: Falls back to HTTP if WebSocket fails
- **Health Monitoring**: Ping/pong to ensure connection health
- **Graceful Degradation**: Works with or without WebSocket

## Setup Instructions

### 1. Install Python Dependencies
```bash
cd /Users/ninad/dspcoder-org/dspcoder-vscode-extension
pip install -r requirements.txt
```

### 2. Start the WebSocket Backend
```bash
python websocket_backend.py
```

You should see:
```
✅ WebSocket server started on ws://127.0.0.1:7778
🔗 Ready to accept VS Code extension connections
```

### 3. Test the Extension
1. **Press F5** in VS Code to run the extension
2. **Open the Cipher Chat panel** (🤖 icon in Activity Bar)
3. **Send a message** - it will use WebSocket if available, HTTP if not
4. **Watch for backend messages** - the backend will send periodic suggestions

### 4. Test Backend-Initiated Messages
```bash
python test_websocket.py
```

## Message Types

### Extension → Backend
```json
{
  "type": "chat_message",
  "message": "How do I implement binary search?",
  "mode": "ask",
  "context": { /* VS Code context */ },
  "clientId": "vscode_1234_abcd"
}
```

### Backend → Extension  
```json
{
  "type": "backend_message",
  "message": "I noticed you're working on algorithms. Need help?",
  "messageType": "question",
  "timestamp": 1625097600
}
```

## Backend Integration Examples

### Send Proactive Question
```python
# In your backend logic
await chat_server.broadcast_to_all_clients(
    "How's your progress on the current coding challenge?", 
    "question"
)
```

### Send Contextual Suggestion
```python
# When you detect user is stuck
await chat_server.send_backend_message_to_client(
    client_id,
    "💡 Try breaking this problem into smaller steps. Want me to show you how?",
    "suggestion"
)
```

### Monitor User Activity
```python
# Check if user has been inactive
if time.time() - session['last_activity'] > 300:  # 5 minutes
    await chat_server.send_backend_message_to_client(
        client_id,
        "Need any help with your current task?",
        "question"
    )
```

## Connection Status

The extension will show connection status in the VS Code Output panel:
- ✅ `WebSocket connected` - Bidirectional communication active
- 📡 `Using HTTP fallback` - One-way communication (user to backend only)
- 🔄 `Attempting to reconnect...` - Reconnecting after disconnect

## Troubleshooting

### WebSocket Connection Issues
1. **Check if backend is running**: `python websocket_backend.py`
2. **Check port availability**: Make sure port 7778 is free
3. **Check VS Code Output**: Look for WebSocket logs in VS Code Output panel

### Fallback to HTTP
If WebSocket fails, the extension automatically falls back to HTTP on port 7777. You'll see:
```
📡 Using HTTP fallback
```

This means:
- ✅ User can still send messages to backend  
- ❌ Backend cannot initiate conversations
- ✅ All existing functionality works

## Integration with Your AI Backend

Replace the `generate_ai_response` method in `websocket_backend.py` with your actual AI processing:

```python
async def generate_ai_response(self, data):
    message = data.get('message', '')
    mode = data.get('mode', 'ask')
    context = data.get('context', {})
    
    # TODO: Replace with your AI processing
    # response = await your_ai_service.process(message, mode, context)
    
    return response
```

## Advanced Features

### Custom Message Types
Add new message types for specific use cases:

```python
# Backend sends code suggestion
await websocket.send(json.dumps({
    "type": "code_suggestion",
    "code": "def binary_search(arr, target):\n    # implementation",
    "language": "python",
    "explanation": "Here's an optimized version"
}))
```

### User Response Handling
Handle responses to backend questions:

```python
elif message_type == 'user_response':
    question_id = data.get('questionId')
    response = data.get('response')
    # Process user's response to your question
```

## Production Considerations

- **Security**: Add authentication for production use
- **Scaling**: Use Redis or similar for multi-instance deployments  
- **Monitoring**: Add proper logging and metrics
- **Rate Limiting**: Prevent spam from backend messages

## Next Steps

1. **Test the current implementation** with your VS Code extension
2. **Integrate with your AI backend** by replacing the demo response logic
3. **Add custom message types** for your specific use cases
4. **Implement user response handling** for interactive conversations
