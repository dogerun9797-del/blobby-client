import React, { useRef, useEffect, useState, useCallback } from 'react';

// --- CONSTANTS ---
const WORLD_WIDTH = 3000;
const WORLD_HEIGHT = 3000;
const INITIAL_PLAYER_MASS = 20; // Used for camera zoom before first state sync
// Hardcode the single server address as requested
const SERVER_URL = 'wss://blobby-io-server.onrender.com';


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

    const socket = new WebSocket(SERVER_URL);
    socketRef.current = socket;

    socket.onopen = () => {
        console.log("WebSocket connection established.");
        socket.send(JSON.stringify({ type: 'join', data: { name: playerName || 'Player' } }));
    };

    socket.onmessage = (event) => {
        try {
            let message;
            const rawData = JSON.parse(event.data);
            if (typeof rawData.message === 'string') {
                message = JSON.parse(rawData.message);
            } else {
                message = rawData;
            }

            if (!message || !message.type) return;
            
            switch (message.type) {
                case 'init':
                    playerIdRef.current = message.data.playerId;
                    setGameState('playing');
                    break;
                case 'gameState':
                    gameDataRef.current = message.data;
                    break;
                case 'leaderboard':
                    const myId = playerIdRef.current;
                    const newLeaderboard = message.data.map((p: any) => ({ ...p, isPlayer: p.id === myId }));
                    setLeaderboard(newLeaderboard);
                    break;
                case 'chat':
                    addMessage(message.data.name, message.data.text, message.data.color);
                    break;
                case 'playerDied':
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
  }, [playerName, addMessage, gameState]);

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
    ctx.lineWidth = 2 / cameraRef.current.zoom;
    for (let x = 0; x <= WORLD_WIDTH; x += 100) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, WORLD_HEIGHT); ctx.stroke();
    }
    for (let y = 0; y <= WORLD_HEIGHT; y += 100) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(WORLD_WIDTH, y); ctx.stroke();
    }

    gameDataRef.current.food.forEach(food => {
        ctx.beginPath(); ctx.arc(food.pos.x, food.pos.y, food.radius, 0, Math.PI * 2); ctx.fillStyle = food.color; ctx.fill();
    });

    [...gameDataRef.current.blobs].sort((a, b) => a.mass - b.mass).forEach(blob => {
        ctx.beginPath(); ctx.arc(blob.pos.x, blob.pos.y, blob.radius, 0, Math.PI * 2); ctx.fillStyle = blob.color; ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = blob.radius * 0.1; ctx.stroke();

        const fontSize = Math.max(12 / cameraRef.current.zoom, blob.radius / 3);
        ctx.fillStyle = 'white'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.shadowColor = 'black';
        ctx.shadowBlur = 5;
        ctx.fillText(blob.name, blob.pos.x, blob.pos.y);
        ctx.shadowBlur = 0;
    });
    ctx.restore();
    animationFrameId.current = requestAnimationFrame(gameLoop);
  }, []);

  useEffect(() => {
    const intervalId = setInterval(() => {
        if (socketRef.current?.readyState === WebSocket.OPEN && gameState === 'playing') {
            const worldPos = {
                x: cameraRef.current.x + (mousePosRef.current.x - windowSize.width / 2) / cameraRef.current.zoom,
                y: cameraRef.current.y + (mousePosRef.current.y - windowSize.height / 2) / cameraRef.current.zoom,
            };
            socketRef.current.send(JSON.stringify({ type: 'target', data: worldPos }));
        }
    }, 50);
    return () => clearInterval(intervalId);
  }, [gameState, windowSize.width, windowSize.height]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (document.activeElement === chatInputRef.current) return;

    if (gameState === 'playing') {
      if (e.code === 'Space') {
          socketRef.current?.send(JSON.stringify({ type: 'split' }));
      } else if (e.code === 'KeyW') {
          socketRef.current?.send(JSON.stringify({ type: 'eject' }));
      } else if (e.key === 'Enter') {
          e.preventDefault();
          chatInputRef.current?.focus();
      }
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
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-900 bg-opacity-80 backdrop-blur-sm text-center p-4 overflow-hidden">
                    <div className="absolute top-1/4 left-1/4 w-32 h-32 bg-cyan-500 rounded-full opacity-50 filter blur-2xl blob-float" style={{ animationDelay: '0s' }}></div>
                    <div className="absolute top-1/2 right-1/4 w-48 h-48 bg-purple-500 rounded-full opacity-50 filter blur-2xl blob-float" style={{ animationDelay: '-2s' }}></div>
                    <div className="absolute bottom-1/4 left-1/3 w-24 h-24 bg-yellow-400 rounded-full opacity-50 filter blur-2xl blob-float" style={{ animationDelay: '-4s' }}></div>
                    
                    <div className="relative z-10">
                      <h1 className="text-7xl font-bold text-white mb-4 tracking-wider" style={{ textShadow: '0 0 15px rgba(255,255,255,0.5)'}}>Blobby.io</h1>
                      <p className="text-xl text-cyan-300 mb-8">Eat, grow, conquer.</p>
                      <div className="w-full max-w-sm space-y-4">
                          <input type="text" placeholder="Enter your name" maxLength={15} value={playerName} onChange={(e) => setPlayerName(e.target.value)}
                            className="w-full px-4 py-3 text-xl text-center text-white bg-black bg-opacity-30 border-2 border-gray-600 rounded-lg focus:outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/50 transition-all" />
                      </div>
                      <div className="text-lg text-gray-300 my-8 max-w-lg space-y-2 bg-black bg-opacity-20 p-4 rounded-lg">
                        <p><span className="font-bold text-white">Move mouse</span> to control your blob.</p>
                        <p><span className="font-bold text-yellow-300">Space</span> to split.</p>
                        <p><span className="font-bold text-green-300">W</span> to eject mass.</p>
                      </div>
                      <button onClick={connectToServer} className="px-10 py-4 text-2xl font-bold text-white bg-gradient-to-r from-cyan-500 to-blue-600 rounded-lg shadow-lg hover:shadow-cyan-500/50 transition-all transform hover:scale-105">
                        Play
                      </button>
                    </div>
                  </div>
              );
          case 'connecting':
              return <div className="absolute inset-0 flex items-center justify-center bg-gray-900 bg-opacity-80 backdrop-blur-sm text-white text-3xl animate-pulse">Connecting...</div>;
          case 'disconnected':
          case 'gameOver':
              return (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-900 bg-opacity-80 backdrop-blur-sm text-center">
                    <h1 className="text-6xl font-bold text-red-500 mb-4" style={{ textShadow: '0 0 10px rgba(239, 68, 68, 0.7)'}}>{gameState === 'gameOver' ? 'Game Over' : 'Disconnected'}</h1>
                    <p className="text-3xl text-white mb-2">Final Score</p>
                    <p className="text-5xl font-bold text-yellow-400 mb-8">{score}</p>
                    <button onClick={resetAndGoToStart} className="px-8 py-4 text-2xl font-bold text-white bg-gradient-to-r from-green-500 to-emerald-600 rounded-lg shadow-lg hover:shadow-green-500/50 transition-transform transform hover:scale-105">
                      Main Menu
                    </button>
                  </div>
              );
          case 'playing':
              return (
                  <>
                    <div className="absolute top-4 left-4 text-white bg-black/50 backdrop-blur-sm p-4 rounded-lg shadow-lg">
                      <h2 className="text-2xl font-bold">Score: {score}</h2>
                    </div>
                    <div className="absolute top-4 right-4 text-white bg-black/50 backdrop-blur-sm p-4 rounded-lg shadow-lg w-64">
                      <h2 className="text-xl font-bold text-center mb-2 border-b border-gray-600 pb-1">Leaderboard</h2>
                      <ol className="list-decimal list-inside space-y-1">
                          {leaderboard.map((entry) => (
                              <li key={entry.id} className={`truncate ${entry.isPlayer ? 'text-yellow-300 font-bold' : ''}`}>
                                  {entry.name} - {entry.mass}
                              </li>
                          ))}
                      </ol>
                    </div>
                    <div className="absolute bottom-4 left-4 text-white w-96 max-w-[80vw]">
                       <div className="bg-black/50 backdrop-blur-sm p-2 rounded-lg max-h-48 overflow-y-auto text-sm">
                          {messages.map(msg => (
                              <p key={msg.id}>
                                  <span style={{ color: msg.color, textShadow: '0 0 5px ' + msg.color }} className="font-bold">{msg.name}: </span>
                                  <span>{msg.text}</span>
                              </p>
                          ))}
                      </div>
                      <input ref={chatInputRef} type="text" placeholder="Press Enter to chat..." maxLength={50} value={chatInput}
                          onChange={(e) => setChatInput(e.target.value)} onKeyDown={handleSendMessage}
                          className="mt-2 w-full px-3 py-2 text-sm text-white bg-black/50 backdrop-blur-sm border border-gray-600 rounded-lg focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400/50 transition-all" />
                    </div>
                  </>
              );
      }
  }

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-gray-800 font-sans cursor-crosshair">
      <canvas ref={canvasRef} width={windowSize.width} height={windowSize.height} className="absolute inset-0" />
      {renderGameState()}
    </div>
  );
};

export default App;
