import React, { useRef, useEffect, useState, useCallback } from 'react';

// --- CONSTANTS ---
const WORLD_WIDTH = 3000;
const WORLD_HEIGHT = 3000;
const INITIAL_PLAYER_MASS = 20;
const FOOD_COUNT = 200;
const FOOD_MASS = 1;
const MIN_MASS_TO_SPLIT = 30;
const RECOMBINE_DELAY_MS = 25000; // 25 seconds until player blobs can merge
const SPLIT_EJECT_SPEED = 20;
const SERVER_TICK_RATE = 1000 / 60; // 60 FPS

// --- TYPES ---
interface Vector {
  x: number;
  y: number;
}

interface Blob {
  id: string;
  pos: Vector;
  mass: number;
  radius: number;
  color: string;
  velocity: Vector;
  name: string;
  canRecombineTime: number; 
  playerId: string;
}

interface Food {
  pos: Vector;
  mass: number;
  radius: number;
  color: string;
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
    playerId: string;
}

interface GameState {
    blobs: Blob[];
    food: Food[];
    leaderboard: LeaderboardEntry[];
    messages: ChatMessage[];
}

// --- UTILITY FUNCTIONS ---
const random = (min: number, max: number) => Math.random() * (max - min) + min;
const randomColor = () => `hsl(${random(0, 360)}, 100%, 50%)`;
const distance = (p1: Vector, p2: Vector) => Math.hypot(p1.x - p2.x, p1.y - p2.y);
const lerp = (start: number, end: number, amt: number) => (1 - amt) * start + amt * end;
const massToRadius = (mass: number) => Math.sqrt(mass / Math.PI) * 10;

const getMaxBlobsForMass = (mass: number) => {
    if (mass >= 240) return 16;
    if (mass >= 120) return 8;
    if (mass >= 60) return 4;
    if (mass >= MIN_MASS_TO_SPLIT) return 2;
    return 1;
};

// --- GAME SERVER (BACKEND) ---
class GameServer {
    private blobs = new Map<string, Blob>();
    private food: Food[] = [];
    private messages: ChatMessage[] = [];
    private tickInterval: number | null = null;
    private onStateUpdate: (state: GameState) => void = () => {};
    private playerNames = new Map<string, string>();

    constructor() {
        this.food = Array.from({ length: FOOD_COUNT }, () => this.createFood());
    }

    private createBlob(playerId: string, name: string): Blob {
        const mass = INITIAL_PLAYER_MASS;
        return {
          id: `${playerId}-${Date.now()}-${Math.random()}`,
          playerId,
          pos: { x: random(0, WORLD_WIDTH), y: random(0, WORLD_HEIGHT) },
          mass: mass,
          radius: massToRadius(mass),
          color: randomColor(),
          velocity: { x: 0, y: 0 },
          name,
          canRecombineTime: Date.now(),
        };
    }

    private createFood(): Food {
        const mass = FOOD_MASS;
        return {
            pos: { x: random(0, WORLD_WIDTH), y: random(0, WORLD_HEIGHT) },
            mass,
            radius: massToRadius(mass),
            color: randomColor(),
        };
    }

    public registerStateUpdateCallback(callback: (state: GameState) => void) {
        this.onStateUpdate = callback;
    }

    public start() {
        if (this.tickInterval) return;
        this.tickInterval = window.setInterval(() => this.tick(), SERVER_TICK_RATE);
    }

    public stop() {
        if (this.tickInterval) {
            clearInterval(this.tickInterval);
            this.tickInterval = null;
        }
    }

    private tick() {
        const allBlobs = Array.from(this.blobs.values());

        // --- MOVEMENT ---
        allBlobs.forEach(blob => {
            blob.pos.x = Math.max(0, Math.min(WORLD_WIDTH, blob.pos.x + blob.velocity.x));
            blob.pos.y = Math.max(0, Math.min(WORLD_HEIGHT, blob.pos.y + blob.velocity.y));

             // Slow down blob over time
            blob.velocity.x *= 0.98;
            blob.velocity.y *= 0.98;
        });

        // --- EATING & COLLISIONS ---
        // Blob vs Food
        for (const blob of allBlobs) {
            this.food = this.food.filter(food => {
                if (distance(blob.pos, food.pos) < blob.radius) {
                    blob.mass += food.mass;
                    blob.radius = massToRadius(blob.mass);
                    return false;
                }
                return true;
            });
        }
        while (this.food.length < FOOD_COUNT) {
            this.food.push(this.createFood());
        }

        // Blob vs Blob
        const consumedBlobIds = new Set<string>();
        for (let i = 0; i < allBlobs.length; i++) {
            for (let j = i + 1; j < allBlobs.length; j++) {
                const b1 = allBlobs[i];
                const b2 = allBlobs[j];
                if (consumedBlobIds.has(b1.id) || consumedBlobIds.has(b2.id)) continue;
                
                const dist = distance(b1.pos, b2.pos);

                // Recombination
                if (b1.playerId === b2.playerId && b1.playerId !== '') {
                    const now = Date.now();
                    if (now > b1.canRecombineTime && now > b2.canRecombineTime) {
                         if (dist < b1.radius || dist < b2.radius) {
                            b1.mass += b2.mass;
                            b1.radius = massToRadius(b1.mass);
                            consumedBlobIds.add(b2.id);
                        }
                    }
                }
                // Engulfment
                else {
                    if (b1.mass > b2.mass * 1.1 && dist < b1.radius - b2.radius * 0.5) {
                        b1.mass += b2.mass;
                        b1.radius = massToRadius(b1.mass);
                        consumedBlobIds.add(b2.id);
                    } else if (b2.mass > b1.mass * 1.1 && dist < b2.radius - b1.radius * 0.5) {
                        b2.mass += b1.mass;
                        b2.radius = massToRadius(b2.mass);
                        consumedBlobIds.add(b1.id);
                    }
                }
            }
        }
        if (consumedBlobIds.size > 0) {
            consumedBlobIds.forEach(id => this.blobs.delete(id));
        }
        
        // --- EMIT STATE ---
        this.pushState();
    }
    
    private pushState() {
        const blobs = Array.from(this.blobs.values());

        const playerMasses = new Map<string, number>();
        blobs.forEach(b => {
            playerMasses.set(b.playerId, (playerMasses.get(b.playerId) || 0) + b.mass);
        });

        const leaderboard: LeaderboardEntry[] = Array.from(playerMasses.entries()).map(([playerId, mass]) => ({
            playerId,
            name: this.playerNames.get(playerId) || 'Unknown',
            mass: Math.floor(mass),
        })).sort((a, b) => b.mass - a.mass).slice(0, 10);
        
        this.onStateUpdate({
            blobs,
            food: this.food,
            leaderboard,
            messages: this.messages,
        });
    }

    // --- PLAYER ACTIONS ---
    public connectPlayer(name: string): string {
        const playerId = `${name}-${Date.now()}`;
        this.playerNames.set(playerId, name);
        const blob = this.createBlob(playerId, name);
        this.blobs.set(blob.id, blob);
        this.pushState(); // Immediately push state so client knows about the new blob
        return playerId;
    }

    public disconnectPlayer(playerId: string) {
        Array.from(this.blobs.values()).forEach(blob => {
            if (blob.playerId === playerId) {
                this.blobs.delete(blob.id);
            }
        });
        this.playerNames.delete(playerId);
    }

    public updatePlayerInput(playerId: string, mousePos: Vector, windowSize: {width: number, height: number}, camera: {x:number, y:number, zoom: number}) {
        const playerBlobs = Array.from(this.blobs.values()).filter(b => b.playerId === playerId);
        if (playerBlobs.length === 0) return;

        playerBlobs.sort((a,b) => b.mass - a.mass);
        const mainBlob = playerBlobs[0];

        const mainBlobScreenPos = {
            x: (mainBlob.pos.x - camera.x) * camera.zoom + windowSize.width / 2,
            y: (mainBlob.pos.y - camera.y) * camera.zoom + windowSize.height / 2,
        };
        const mainBlobScreenRadius = mainBlob.radius * camera.zoom;
        const isMouseOverMainBlob = distance(mousePos, mainBlobScreenPos) < mainBlobScreenRadius;

        const mouseInWorld = {
            x: mainBlob.pos.x + (mousePos.x - windowSize.width / 2) / camera.zoom,
            y: mainBlob.pos.y + (mousePos.y - windowSize.height / 2) / camera.zoom,
        };

        playerBlobs.forEach((p_blob, index) => {
             let targetPos: Vector;

            if (index === 0) {
                targetPos = mouseInWorld;
            } else {
                if (isMouseOverMainBlob) {
                    targetPos = mainBlob.pos;
                } else {
                    const orbitDistance = mainBlob.radius + p_blob.radius + 15;
                    const angleOffset = Date.now() / 3000;
                    const angle = ((index - 1) / (playerBlobs.length - 1)) * 2 * Math.PI + angleOffset;
                    targetPos = {
                        x: mainBlob.pos.x + Math.cos(angle) * orbitDistance,
                        y: mainBlob.pos.y + Math.sin(angle) * orbitDistance,
                    };
                }
            }
            
            const distToTarget = distance(p_blob.pos, targetPos);
            if (distToTarget > 1) {
                const angle = Math.atan2(targetPos.y - p_blob.pos.y, targetPos.x - p_blob.pos.x);
                const speed = Math.min(distToTarget * 0.1, 5 / (1 + p_blob.mass * 0.01));
                const targetVx = Math.cos(angle) * speed;
                const targetVy = Math.sin(angle) * speed;
                p_blob.velocity.x = lerp(p_blob.velocity.x, targetVx, 0.15);
                p_blob.velocity.y = lerp(p_blob.velocity.y, targetVy, 0.15);
            }
        });
    }

    public playerSplit(playerId: string, mousePos: Vector, windowSize: {width: number, height: number}, camera: {x:number, y:number, zoom: number}) {
        const playerBlobs = Array.from(this.blobs.values()).filter(b => b.playerId === playerId);
        const totalPlayerMass = playerBlobs.reduce((sum, b) => sum + b.mass, 0);
        const maxBlobs = getMaxBlobsForMass(totalPlayerMass);
        if (playerBlobs.length >= maxBlobs) return;

        const newBlobs: Blob[] = [];
        const recombineTime = Date.now() + RECOMBINE_DELAY_MS;
        
        playerBlobs.forEach(p_blob => {
            if (p_blob.mass >= MIN_MASS_TO_SPLIT && (playerBlobs.length + newBlobs.length < maxBlobs)) {
                p_blob.mass /= 2;
                p_blob.radius = massToRadius(p_blob.mass);
                p_blob.canRecombineTime = recombineTime;

                const mouseInWorld = {
                    x: p_blob.pos.x + (mousePos.x - windowSize.width / 2) / camera.zoom,
                    y: p_blob.pos.y + (mousePos.y - windowSize.height / 2) / camera.zoom,
                };
                const angle = Math.atan2(mouseInWorld.y - p_blob.pos.y, mouseInWorld.x - p_blob.pos.x);
                const ejectionDistance = p_blob.radius * 2.5;
                
                const newBlob: Blob = {
                    ...p_blob,
                    id: `${p_blob.playerId}-split-${Date.now()}-${Math.random()}`,
                    mass: p_blob.mass,
                    radius: p_blob.radius,
                    pos: {
                        x: p_blob.pos.x + Math.cos(angle) * ejectionDistance,
                        y: p_blob.pos.y + Math.sin(angle) * ejectionDistance,
                    },
                    velocity: {
                        x: p_blob.velocity.x + Math.cos(angle) * SPLIT_EJECT_SPEED,
                        y: p_blob.velocity.y + Math.sin(angle) * SPLIT_EJECT_SPEED,
                    },
                    canRecombineTime: recombineTime,
                };
                newBlobs.push(newBlob);
            }
        });

        newBlobs.forEach(b => this.blobs.set(b.id, b));
    }

    public addMessage(name: string, text: string, color: string) {
        const newMsg = { id: Date.now() + Math.random(), name, text, color };
        this.messages = [...this.messages, newMsg].slice(-10);
    }
}

// --- MAIN COMPONENT (CLIENT) ---
const App: React.FC = () => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const chatInputRef = useRef<HTMLInputElement>(null);
    const animationFrameId = useRef<number | null>(null);
    const mousePosRef = useRef<Vector>({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const cameraRef = useRef({ x: 0, y: 0, zoom: 1 });
    const [server] = useState(() => new GameServer());
    const playerIdRef = useRef<string | null>(null);

    const [uiState, setUiState] = useState<'start' | 'playing' | 'gameOver'>('start');
    const [serverState, setServerState] = useState<GameState | null>(null);
    const [score, setScore] = useState(0);
    const [windowSize, setWindowSize] = useState({ width: window.innerWidth, height: window.innerHeight });
    const [playerName, setPlayerName] = useState("Player");
    const [chatInput, setChatInput] = useState("");

    // --- SERVER CONNECTION & STATE SYNC ---
    useEffect(() => {
        server.registerStateUpdateCallback((newState) => {
            setServerState(newState);
        });
        server.start();

        return () => {
            server.stop();
            if (playerIdRef.current) {
                server.disconnectPlayer(playerIdRef.current);
            }
        };
    }, [server]);

    useEffect(() => {
        if (uiState === 'playing' && serverState && playerIdRef.current) {
            const myBlobs = serverState.blobs.filter(b => b.playerId === playerIdRef.current);
            if (myBlobs.length === 0) {
                setUiState('gameOver');
            } else {
                const totalMass = myBlobs.reduce((acc, b) => acc + b.mass, 0);
                setScore(Math.floor(totalMass));
            }
        }
    }, [serverState, uiState]);
    
    // --- GAME ACTIONS ---
    const startGame = useCallback(() => {
        const id = server.connectPlayer(playerName || "Player");
        playerIdRef.current = id;
        
        // Find initial player blob to set camera
        const initialBlob = Array.from(server['blobs'].values()).find(b => b.playerId === id);
        if(initialBlob) {
            cameraRef.current = { x: initialBlob.pos.x, y: initialBlob.pos.y, zoom: 1 };
        }

        setUiState('playing');
        setScore(INITIAL_PLAYER_MASS)
    }, [server, playerName]);

    const handleSendMessage = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter' && chatInput.trim() !== "" && playerIdRef.current) {
            const myBlobs = serverState?.blobs.filter(b => b.playerId === playerIdRef.current) ?? [];
            const playerColor = myBlobs[0]?.color || '#FFFFFF';
            server.addMessage(playerName, chatInput, playerColor);
            setChatInput("");
            chatInputRef.current?.blur();
        }
    };

    // --- RENDER LOOP ---
    const gameLoop = useCallback(() => {
        if (!playerIdRef.current || uiState !== 'playing') return;
        
        // Send input to server
        server.updatePlayerInput(playerIdRef.current, mousePosRef.current, windowSize, cameraRef.current);
        
        // --- DRAW LOGIC ---
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!ctx || !canvas || !serverState) {
            animationFrameId.current = requestAnimationFrame(gameLoop);
            return;
        }

        const myBlobs = serverState.blobs.filter(b => b.playerId === playerIdRef.current);
        const totalPlayerMass = myBlobs.reduce((acc, b) => acc + b.mass, 0);

        // Update Camera
        if (myBlobs.length > 0) {
            const centerOfMass = { x: 0, y: 0 };
            myBlobs.forEach(p => {
                if (p.pos) { // Defensive check
                    centerOfMass.x += p.pos.x * p.mass;
                    centerOfMass.y += p.pos.y * p.mass;
                }
            });
            centerOfMass.x /= totalPlayerMass;
            centerOfMass.y /= totalPlayerMass;

            cameraRef.current.x = lerp(cameraRef.current.x, centerOfMass.x, 0.1);
            cameraRef.current.y = lerp(cameraRef.current.y, centerOfMass.y, 0.1);
        }
        const targetZoom = Math.max(0.2, 30 / massToRadius(totalPlayerMass || INITIAL_PLAYER_MASS));
        cameraRef.current.zoom = lerp(cameraRef.current.zoom, targetZoom, 0.1);

        // Clear and transform canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.save();
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.scale(cameraRef.current.zoom, cameraRef.current.zoom);
        ctx.translate(-cameraRef.current.x, -cameraRef.current.y);
        
        // Draw grid
        ctx.strokeStyle = '#374151';
        ctx.lineWidth = 1 / cameraRef.current.zoom;
        for (let x = 0; x <= WORLD_WIDTH; x += 50) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, WORLD_HEIGHT); ctx.stroke();
        }
        for (let y = 0; y <= WORLD_HEIGHT; y += 50) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(WORLD_WIDTH, y); ctx.stroke();
        }

        // Draw food
        serverState.food.forEach(food => {
             if (!food.pos) return; // Defensive check
            ctx.beginPath(); ctx.arc(food.pos.x, food.pos.y, food.radius, 0, Math.PI * 2); ctx.fillStyle = food.color; ctx.fill();
        });

        // Draw blobs
        [...serverState.blobs].sort((a,b) => a.mass - b.mass).forEach(blob => {
            if (!blob.pos) return; // Defensive check
            ctx.beginPath(); ctx.arc(blob.pos.x, blob.pos.y, blob.radius, 0, Math.PI * 2); ctx.fillStyle = blob.color; ctx.fill();
            ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = blob.radius * 0.1; ctx.stroke();
            const fontSize = Math.max(12 / cameraRef.current.zoom, blob.radius / 3);
            ctx.fillStyle = 'white'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.font = `bold ${fontSize}px sans-serif`;
            ctx.fillText(blob.name, blob.pos.x, blob.pos.y);
        });

        ctx.restore();

        animationFrameId.current = requestAnimationFrame(gameLoop);
    }, [server, uiState, serverState, windowSize]);

    // --- EVENT LISTENERS ---
    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (e.code === 'Space' && uiState === 'playing' && document.activeElement !== chatInputRef.current) {
            if (playerIdRef.current) {
                server.playerSplit(playerIdRef.current, mousePosRef.current, windowSize, cameraRef.current);
            }
        }
    }, [uiState, windowSize, server]);

    useEffect(() => {
        const handleResize = () => setWindowSize({ width: window.innerWidth, height: window.innerHeight });
        const handleMouseMove = (e: MouseEvent) => { mousePosRef.current = { x: e.clientX, y: e.clientY }; };
        
        window.addEventListener('resize', handleResize);
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('keydown', handleKeyDown);

        if (uiState === 'playing') { animationFrameId.current = requestAnimationFrame(gameLoop); }

        return () => {
            if (animationFrameId.current !== null) { cancelAnimationFrame(animationFrameId.current); }
            window.removeEventListener('resize', handleResize);
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [uiState, gameLoop, handleKeyDown]);

    const leaderboard = serverState?.leaderboard ?? [];
    const messages = serverState?.messages ?? [];

    return (
        <div className="relative w-screen h-screen overflow-hidden bg-gray-800 font-sans">
        <canvas ref={canvasRef} width={windowSize.width} height={windowSize.height} />

        {uiState === 'start' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black bg-opacity-70 text-center p-4">
            <h1 className="text-6xl font-bold text-white mb-4 tracking-wider">Blobby.io</h1>
            <input
                type="text" placeholder="Enter your name" maxLength={15} value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                className="mb-6 px-4 py-2 text-xl text-center text-white bg-gray-700 border-2 border-gray-500 rounded-lg focus:outline-none focus:border-blue-500"
            />
            <div className="text-lg text-gray-300 mb-8 max-w-lg space-y-2">
                <p>Move mouse to control. Eat food and other players to grow.</p>
                <p>Press <span className="font-bold text-yellow-300">Space</span> to split. The bigger you are, the more you can split!</p>
                <p>Your blobs will automatically recombine after <span className="font-bold text-cyan-300">25 seconds</span>.</p>
            </div>
            <button
                onClick={startGame}
                className="px-8 py-4 text-2xl font-bold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-transform transform hover:scale-105"
            >Play</button>
            </div>
        )}

        {uiState === 'playing' && (
            <>
            <div className="absolute top-4 left-4 text-white bg-black bg-opacity-50 p-4 rounded-lg">
                <h2 className="text-2xl font-bold">Score: {score}</h2>
            </div>
            <div className="absolute top-4 right-4 text-white bg-black bg-opacity-50 p-4 rounded-lg w-64">
                <h2 className="text-xl font-bold text-center mb-2 border-b border-gray-600 pb-1">Leaderboard</h2>
                <ol className="list-decimal list-inside">
                    {leaderboard.map((entry, index) => (
                        <li key={index} className={`truncate ${entry.playerId === playerIdRef.current ? 'text-yellow-400 font-bold' : ''}`}>
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
                <input 
                    ref={chatInputRef} type="text" placeholder="Press Enter to chat..." maxLength={50}
                    value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={handleSendMessage}
                    className="mt-2 w-full px-3 py-1 text-sm text-white bg-gray-700 bg-opacity-80 border border-gray-600 rounded-lg focus:outline-none"
                />
            </div>
            </>
        )}

        {uiState === 'gameOver' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black bg-opacity-70">
            <h1 className="text-6xl font-bold text-red-500 mb-4">Game Over</h1>
            <p className="text-3xl text-white mb-2">Final Score</p>
            <p className="text-5xl font-bold text-yellow-400 mb-8">{score}</p>
            <button
                onClick={startGame}
                className="px-8 py-4 text-2xl font-bold text-white bg-green-600 rounded-lg hover:bg-green-700 transition-transform transform hover:scale-105"
            >Play Again</button>
            </div>
        )}
        </div>
    );
};

export default App;
