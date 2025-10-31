
import React, { useRef, useEffect, useState, useCallback } from 'react';

// --- CONSTANTS ---
const WORLD_WIDTH = 3000;
const WORLD_HEIGHT = 3000;
const INITIAL_PLAYER_MASS = 20; // Used for camera zoom before first state sync
// NOTE: This is a public WebSocket test server. For a real game, you would host your own backend.
// This server simply broadcasts messages to all connected clients.
// It does not run any game logic (like eating or scoring).
const DEFAULT_WEBSOCKET_URL = 'wss://socketsbay.com/wss/v2/1/demo/';


// --- TYPES --- (Shared with a potential server)
interface Vector {
  x: number;
  y: number;
}

interface Blob {
  id: string;      // Unique ID for each blob piece
  ownerId: string; // ID of the player who owns this blob
  pos: Vector;
  mass: number;
  radius: number;
  color: string;
  name: string;
}

interface Food {
  id: string;
  pos: Vector;
  radius: number;
  color: string;
}

interface GameSnapshot {
    blobs: Blob[];
    food: Food[];
}

interface ChatMessage {
    id: number;
    name: string;
    text: string;
    color: string;
}

interface LeaderboardEntry {
    name: string;
    mass: number;
    isPlayer: boolean;
    id: string; // player id
}

// --- UTILITY FUNCTIONS ---
const lerp = (start: number, end: number, amt: number) => (1 - amt) * start + amt * end;
const massToRadius = (mass: number) => Math.sqrt(mass / Math.PI) * 10;


// --- MAIN COMPONENT ---
const App: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chatInputRef = useRef<HTMLInputElement>(null);
  // FIX: The useRef hook requires an initial value. Initialize with undefined and update the type.
  const animationFrameId = useRef<number | undefined>(undefined);
  const mousePosRef = useRef<Vector>({ x: window.innerWidth / 2, y: window.innerHeight / 2 });

  // Multiplayer-specific refs
  const socketRef = useRef<WebSocket | null>(null);
  const playerIdRef = useRef<string | null>(null);
  const gameDataRef = useRef<GameSnapshot>({ blobs: [], food: [] });
  const cameraRef = useRef({ x: 0, y: 0, zoom: 1 });

  const [gameState, setGameState] = useState<'start' | 'connecting' | 'playing' | 'gameOver' | 'disconnected'>('start');
  const [score, setScore] = useState(0);
  const [windowSize, setWindowSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [playerName, setPlayerName] = useState("Player");
  const [serverUrl, setServerUrl] = useState(DEFAULT_WEBSOCKET_URL);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");

  const addMessage = useCallback((name: string, text: string, color: string) => {
    setMessages(prev => {
        const newMsg = { id: Date.now() + Math.random(), name, text, color };
        return [...prev, newMsg].slice(-10);
    });
  }, []);

  const connectToServer = useCallback(() => {
    if (socketRef.current) {
        socketRef.current.close();
    }
    setGameState('connecting');

    const socket = new WebSocket(serverUrl);
    socketRef.current = socket;

    socket.onopen = () => {
        console.log("WebSocket connection established.");
        // Announce our arrival to the server. The server would then create our player.
        socket.send(JSON.stringify({ type: 'join', data: { name: playerName || 'Player' } }));
    };

    socket.onmessage = (event) => {
        try {
            let message;
            const rawData = JSON.parse(event.data);

            // Check if it's the wrapped format from the public test server (socketsbay)
            if (typeof rawData.message === 'string') {
                message = JSON.parse(rawData.message);
            } else {
                // Assume it's the direct format from our own server
                message = rawData;
            }

            if (!message || !message.type) return;
            
            // The server would send different types of messages to update the client.
            switch (message.type) {
                case 'init': // Server assigns us our unique ID
                    playerIdRef.current = message.data.playerId;
                    setGameState('playing');
                    break;
                case 'gameState': // The server sends a snapshot of the world
                    gameDataRef.current = message.data;
                    break;
                case 'leaderboard': // Server sends updated leaderboard
                    const myId = playerIdRef.current;
                    const newLeaderboard = message.data.map((p: any) => ({ ...p, isPlayer: p.id === myId }));
                    setLeaderboard(newLeaderboard);
                    break;
                case 'chat': // Another player sent a message
                    addMessage(message.data.name, message.data.text, message.data.color);
                    break;
                case 'playerDied': // The server informs us we died
                    if (message.data.playerId === playerIdRef.current) {
                        setGameState('gameOver');
                        socket.close();
                    }
                    break;
            }
        } catch (error) {
            console.error("Failed to parse server message:", event.data, error);
        }
    };

    socket.onerror = (error) => {
        console.error("WebSocket error:", error);
        setGameState('disconnected');
    };

    socket.onclose = () => {
        console.log("WebSocket connection closed.");
        if (gameState === 'playing') {
            setGameState('disconnected');
        }
    };
  }, [playerName, addMessage, gameState, serverUrl]);

  const handleSendMessage = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && chatInput.trim() !== "" && socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: 'chat', data: { text: chatInput } }));
        setChatInput("");
        chatInputRef.current?.blur();
    }
  };

  const gameLoop = useCallback(() => {
    const myBlobs = gameDataRef.current.blobs.filter(b => b.ownerId === playerIdRef.current);
    const canvas = canvasRef.current;
    if (!canvas) return;

    let totalPlayerMass = 0;
    const centerOfMass = { x: 0, y: 0 };
    if (myBlobs.length > 0) {
        myBlobs.forEach(p => {
            totalPlayerMass += p.mass;
            centerOfMass.x += p.pos.x * p.mass;
            centerOfMass.y += p.pos.y * p.mass;
        });
        if (totalPlayerMass > 0) {
            centerOfMass.x /= totalPlayerMass;
            centerOfMass.y /= totalPlayerMass;
        }
        cameraRef.current.x = lerp(cameraRef.current.x, centerOfMass.x, 0.1);
        cameraRef.current.y = lerp(cameraRef.current.y, centerOfMass.y, 0.1);
    }
    
    setScore(Math.floor(totalPlayerMass));
    const targetZoom = Math.max(0.2, 30 / massToRadius(totalPlayerMass || INITIAL_PLAYER_MASS));
    cameraRef.current.zoom = lerp(cameraRef.current.zoom, targetZoom, 0.1);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(cameraRef.current.zoom, cameraRef.current.zoom);
    ctx.translate(-cameraRef.current.x, -cameraRef.current.y);

    ctx.strokeStyle = '#374151';
    ctx.lineWidth = 1 / cameraRef.current.zoom;
    for (let x = 0; x <= WORLD_WIDTH; x += 50) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, WORLD_HEIGHT); ctx.stroke();
    }
    for (let y = 0; y <= WORLD_HEIGHT; y += 50) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(WORLD_WIDTH, y); ctx.stroke();
    }

    gameDataRef.current.food.forEach(food => {
        ctx.beginPath(); ctx.arc(food.pos.x, food.pos.y, food.radius, 0, Math.PI * 2); ctx.fillStyle = food.color; ctx.fill();
    });

    // Draw blobs sorted by mass so smaller ones are on top
    [...gameDataRef.current.blobs].sort((a, b) => a.mass - b.mass).forEach(blob => {
        ctx.beginPath(); ctx.arc(blob.pos.x, blob.pos.y, blob.radius, 0, Math.PI * 2); ctx.fillStyle = blob.color; ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = blob.radius * 0.1; ctx.stroke();

        const fontSize = Math.max(12 / cameraRef.current.zoom, blob.radius / 3);
        ctx.fillStyle = 'white'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.fillText(blob.name, blob.pos.x, blob.pos.y);
    });
    ctx.restore();
    animationFrameId.current = requestAnimationFrame(gameLoop);
  }, []);

  // Send mouse position to server periodically
  useEffect(() => {
    const intervalId = setInterval(() => {
        if (socketRef.current?.readyState === WebSocket.OPEN && gameState === 'playing') {
            const worldPos = {
                x: cameraRef.current.x + (mousePosRef.current.x - windowSize.width / 2) / cameraRef.current.zoom,
                y: cameraRef.current.y + (mousePosRef.current.y - windowSize.height / 2) / cameraRef.current.zoom,
            };
            socketRef.current.send(JSON.stringify({ type: 'target', data: worldPos }));
        }
    }, 50); // 20 times per second
    return () => clearInterval(intervalId);
  }, [gameState, windowSize.width, windowSize.height]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.code === 'Space' && gameState === 'playing' && document.activeElement !== chatInputRef.current) {
        socketRef.current?.send(JSON.stringify({ type: 'split' }));
    }
  }, [gameState]);

  useEffect(() => {
    const handleResize = () => setWindowSize({ width: window.innerWidth, height: window.innerHeight });
    const handleMouseMove = (e: MouseEvent) => { mousePosRef.current = { x: e.clientX, y: e.clientY }; };
    
    window.addEventListener('resize', handleResize);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('keydown', handleKeyDown);

    if (gameState === 'playing' && !animationFrameId.current) {
        animationFrameId.current = requestAnimationFrame(gameLoop);
    }

    return () => {
      if (animationFrameId.current) {
          cancelAnimationFrame(animationFrameId.current);
          animationFrameId.current = undefined;
      }
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('keydown', handleKeyDown);
      socketRef.current?.close();
    };
  }, [gameState, gameLoop, handleKeyDown]);

  const resetAndGoToStart = () => {
      setGameState('start');
      setScore(0);
      gameDataRef.current = { blobs: [], food: [] };
      setLeaderboard([]);
      setMessages([]);
      playerIdRef.current = null;
  }

  const renderGameState = () => {
      switch (gameState) {
          case 'start':
              return (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-black bg-opacity-70 text-center p-4">
                    <h1 className="text-6xl font-bold text-white mb-4 tracking-wider">Blobby.io</h1>
                    <p className="text-xl text-cyan-300 mb-8">Multiplayer Edition</p>
                    <div className="w-full max-w-sm space-y-4">
                        <input type="text" placeholder="Enter your name" maxLength={15} value={playerName} onChange={(e) => setPlayerName(e.target.value)}
                          className="w-full px-4 py-2 text-xl text-center text-white bg-gray-700 border-2 border-gray-500 rounded-lg focus:outline-none focus:border-blue-500" />
                        <div>
                            <label htmlFor="server-url" className="text-sm text-gray-400 block mb-1">Server Address</label>
                            <input
                                id="server-url"
                                type="text"
                                placeholder="wss://your-server-url"
                                value={serverUrl}
                                onChange={(e) => setServerUrl(e.target.value)}
                                className="w-full px-4 py-2 text-md text-center text-white bg-gray-700 border-2 border-gray-500 rounded-lg focus:outline-none focus:border-blue-500"
                            />
                        </div>
                    </div>
                    <div className="text-lg text-gray-300 my-8 max-w-lg space-y-2">
                      <p>Move mouse to control. Eat food and other players to grow.</p>
                      <p>Press <span className="font-bold text-yellow-300">Space</span> to split.</p>
                    </div>
                    <button onClick={connectToServer} className="px-8 py-4 text-2xl font-bold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-transform transform hover:scale-105">
                      Play
                    </button>
                  </div>
              );
          case 'connecting':
              return <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-70 text-white text-3xl">Connecting to server...</div>;
          case 'disconnected':
          case 'gameOver':
              return (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-black bg-opacity-70">
                    <h1 className="text-6xl font-bold text-red-500 mb-4">{gameState === 'gameOver' ? 'Game Over' : 'Disconnected'}</h1>
                    <p className="text-3xl text-white mb-2">Final Score</p>
                    <p className="text-5xl font-bold text-yellow-400 mb-8">{score}</p>
                    <button onClick={resetAndGoToStart} className="px-8 py-4 text-2xl font-bold text-white bg-green-600 rounded-lg hover:bg-green-700 transition-transform transform hover:scale-105">
                      Main Menu
                    </button>
                  </div>
              );
          case 'playing':
              return (
                  <>
                    <div className="absolute top-4 left-4 text-white bg-black bg-opacity-50 p-4 rounded-lg">
                      <h2 className="text-2xl font-bold">Score: {score}</h2>
                    </div>
                    <div className="absolute top-4 right-4 text-white bg-black bg-opacity-50 p-4 rounded-lg w-64">
                      <h2 className="text-xl font-bold text-center mb-2 border-b border-gray-600 pb-1">Leaderboard</h2>
                      <ol className="list-decimal list-inside">
                          {leaderboard.map((entry) => (
                              <li key={entry.id} className={`truncate ${entry.isPlayer ? 'text-yellow-400 font-bold' : ''}`}>
                                  {entry.name} - {entry.mass}
                              </li>
                          ))}
                      </ol>
                    </div>
                    <div className="absolute bottom-4 left-4 text-white w-80">
                       <div className="bg-black bg-opacity-50 p-2 rounded-lg max-h-48 overflow-y-auto">
                          {messages.map(msg => (
                              <p key={msg.id} className="text-sm">
                                  <span style={{ color: msg.color }} className="font-bold">{msg.name}: </span>
                                  <span>{msg.text}</span>
                              </p>
                          ))}
                      </div>
                      <input ref={chatInputRef} type="text" placeholder="Press Enter to chat..." maxLength={50} value={chatInput}
                          onChange={(e) => setChatInput(e.target.value)} onKeyDown={handleSendMessage}
                          className="mt-2 w-full px-3 py-1 text-sm text-white bg-gray-700 bg-opacity-80 border border-gray-600 rounded-lg focus:outline-none" />
                    </div>
                  </>
              );
      }
  }

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-gray-800 font-sans">
      <canvas ref={canvasRef} width={windowSize.width} height={windowSize.height} />
      {renderGameState()}
    </div>
  );
};

export default App;
