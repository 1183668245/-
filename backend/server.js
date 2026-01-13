require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const fs = require('fs');
const { ethers } = require('ethers');


const app = express();
const PORT = process.env.PORT || 3000;

// In-memory storage (Replace with DB in production)
const userStorage = {
    // '0xAddress': { tickets: { colorful: 0, golden: 0 }, pendingReward: 0, pendingGold: 0, isClaiming: false, consecutiveLosses: 0 }
};

// In-memory Prize Claims History
const prizeClaims = [];

// Admin State
let nextGoldBeanTrigger = false;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'password';

const PRIZE_CONFIG = {
    colorful: {
        path: 'Prize Icons/Colorful Scratch',
        // Total Weight: 10000
        prizes: [
            { file: 'First Prize.webp', value: 1000000, weight: 10 },    // 0.1%
            { file: 'Second Prize.webp', value: 500000, weight: 40 },    // 0.4%
            { file: 'Third Prize.webp', value: 200000, weight: 150 },    // 1.5%
            { file: 'Fourth Prize.webp', value: 100000, weight: 800 },   // 8%
            { file: 'Fifth Prize.webp', value: 50000, weight: 4000 },    // 40% (Increased from 20%)
            { file: 'NO_PRIZE', value: 0, weight: 5000 }                 // 50% (Decreased from 70%)
        ]
    },
    golden: {
        path: 'Prize Icons/Golden Scratch',
        // Total Weight: 10000
        prizes: [
            { file: 'Grand Prize.webp', value: 'GOLD_BEAN_1G', weight: 5 }, // 0.05%
            { file: 'First Prize.webp', value: 1000000, weight: 45 },       // 0.45%
            { file: 'Second Prize.webp', value: 500000, weight: 150 },      // 1.5%
            { file: 'Third Prize.webp', value: 200000, weight: 300 },       // 3%
            { file: 'Fourth Prize.webp', value: 100000, weight: 1000 },     // 10%
            { file: 'Fifth Prize.webp', value: 50000, weight: 2500 },       // 25%
            { file: 'NO_PRIZE', value: 0, weight: 6000 }                    // 60%
        ]
    }
};

// Middleware
app.use(cors({
    origin: ['https://guajindou.xyz', 'http://localhost:3000', 'http://127.0.0.1:3000'],
    methods: ['GET', 'POST'],
    credentials: true
}));
app.use(express.json());

// Security Middleware: Block access to backend files and hidden files
app.use((req, res, next) => {
    const forbiddenPaths = ['/backend', '/.env', '/package.json', '/package-lock.json', '/server.js', '/admin.html'];
    const lowerPath = req.path.toLowerCase();
    
    // Check if path starts with forbidden path or contains .env
    if (forbiddenPaths.some(fp => lowerPath.startsWith(fp)) || lowerPath.includes('.env')) {
        return res.status(403).send('Access Denied');
    }
    next();
});

// Admin Route - Serves the hidden admin page
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.use(express.static(path.join(__dirname, '../'))); // Serve static frontend files

    // Helper: Get or Create User
    const getUser = (address) => {
        const addr = address.toLowerCase();
        if (!userStorage[addr]) {
            userStorage[addr] = { 
                tickets: { colorful: 0, golden: 0 }, 
                pendingReward: 0, 
                pendingGold: 0,
                consecutiveLosses: 0, // Track consecutive losses
                isClaiming: false // Concurrency Lock
            };
        }
        return userStorage[addr];
    };

// API Endpoint to get safe config for frontend
app.get('/api/config', (req, res) => {
    // Only expose public info, NEVER private keys
    res.json({
        tokenContractAddress: process.env.TOKEN_CONTRACT_ADDRESS,
        receiveAddress: process.env.RECEIVE_ADDRESS,
        bscChainIdHex: process.env.BSC_CHAIN_ID_HEX,
        bscChainIdDecimal: parseInt(process.env.BSC_CHAIN_ID_DECIMAL),
        bscRpcUrl: process.env.BSC_RPC_URL,
        bscExplorerUrl: process.env.BSC_EXPLORER_URL
    });
});

// 1. Verify Payment & Add Ticket
app.post('/api/verify-payment', (req, res) => {
    const { address, type, txHash, quantity } = req.body;
    // In a real app, verify txHash on-chain here.
    
    if (!address || !type) return res.status(400).json({ error: 'Invalid data' });
    
    const user = getUser(address);
    const qty = parseInt(quantity) || 1; // Default to 1 if missing
    
    // Robust type checking: accept both code and Chinese for backward compatibility
    let ticketType = 'colorful';
    if (type === 'golden' || type === '金色刮刮乐') {
        ticketType = 'golden';
    } else {
        ticketType = 'colorful';
    }
    
    user.tickets[ticketType] += qty;
    
    console.log(`User ${address} bought ${qty} ${ticketType} ticket(s). Tx: ${txHash}`);
    res.json({ success: true, tickets: user.tickets });
});

// 2. Get User Info (Tickets & Pending Rewards)
app.get('/api/user-info', (req, res) => {
    const { address } = req.query;
    if (!address) return res.status(400).json({ error: 'Address required' });
    const user = getUser(address);
    res.json(user);
});

// 3. Play Game (Scratch)
app.post('/api/play', (req, res) => {
    const { address, type } = req.body; // type: 'colorful' or 'golden'
    const user = getUser(address);
    
    if (user.tickets[type] <= 0) {
        return res.status(400).json({ error: 'No tickets available' });
    }

    // Deduct ticket
    user.tickets[type]--;

    // Generate Result with Weighted Random (Multi-Prize Logic)
    const config = PRIZE_CONFIG[type];
    const grid = new Array(16).fill(null);
    let winAmount = 0;
    let wonGold = false;
    let prizeNames = [];
    let isWin = false;
    let winCount = 0;
    const winningIcons = [];

    // --- Admin Trigger Logic (Force Gold Bean) ---
    if (type === 'golden' && nextGoldBeanTrigger) {
        console.log('Admin Trigger Activated: Forcing Gold Bean Prize!');
        winCount = 1; // Force 1 win
        // Find Grand Prize Config
        const grandPrize = config.prizes.find(p => p.value === 'GOLD_BEAN_1G');
        if (grandPrize) {
            winningIcons.push(grandPrize);
            wonGold = true;
            user.pendingGold++;
            prizeNames.push('1g实物金豆');
        } else {
             // Fallback if config error
             console.error("Config Error: Grand Prize not found");
        }
        // Turn off trigger immediately
        nextGoldBeanTrigger = false;
    } else {
        // --- Normal Logic ---
        
        // Helper: Pick a prize based on weights (excluding NO_PRIZE for winning slots)
        const winningPrizes = config.prizes.filter(p => p.file !== 'NO_PRIZE');
        const winningTotalWeight = winningPrizes.reduce((sum, item) => sum + item.weight, 0);

        const pickPrize = () => {
            let randomNum = Math.floor(Math.random() * winningTotalWeight);
            for (const prize of winningPrizes) {
                if (randomNum < prize.weight) {
                    return prize;
                }
                randomNum -= prize.weight;
            }
            return winningPrizes[winningPrizes.length - 1];
        };

        // 1. Determine how many winning slots (0 to 16)
        // We define a probability distribution for number of wins
        // This controls the "Stacked" probability
        const winCountWeights = [
            { count: 0, weight: 7000 }, // 70% chance of no win
            { count: 1, weight: 2500 }, // 25% chance of 1 win
            { count: 2, weight: 400 },  // 4% chance of 2 wins
            { count: 3, weight: 90 },   // 0.9% chance of 3 wins
            { count: 4, weight: 10 }    // 0.1% chance of 4 wins
        ];
        
        // Adjust weights for 'golden' if needed (higher win rate?)
        if (type === 'golden') {
            // Example: Golden ticket has slightly better odds
            winCountWeights[0].weight = 6000; // 60% lose
            winCountWeights[1].weight = 3000; // 30% 1 win
        }

        const totalCountWeight = winCountWeights.reduce((s, i) => s + i.weight, 0);
        let r = Math.floor(Math.random() * totalCountWeight);
        
        for (const wc of winCountWeights) {
            if (r < wc.weight) {
                winCount = wc.count;
                break;
            }
            r -= wc.weight;
        }

        // 2. Generate Prizes
        for (let i = 0; i < winCount; i++) {
            const prize = pickPrize();
            winningIcons.push(prize);
            
            if (prize.value === 'GOLD_BEAN_1G') {
                wonGold = true;
                user.pendingGold++;
                prizeNames.push('1g实物金豆');
            } else {
                winAmount += prize.value;
                user.pendingReward += prize.value;
                prizeNames.push(`${prize.value.toLocaleString()} 代币`);
            }
        }
    } // End else (normal logic)

    if (winCount > 0) isWin = true;

    // --- Pity System Logic ---
    if (isWin) {
        user.consecutiveLosses = 0; // Reset on win
    } else {
        user.consecutiveLosses++; // Increment on loss
    }
    // Limit to 10 visually (logic handled in claim)
    if (user.consecutiveLosses > 10) user.consecutiveLosses = 10; 

    // 3. Fill Grid
    // Hardcoded file list to avoid file system dependency on Railway
    // This solves the 500 error permanently
    const colorfulNoPrizeFiles = [
        'No Prize.webp', 'No Prize (2).webp', 'No Prize (3).webp', 'No Prize (4).webp', 
        'No Prize (5).webp', 'No Prize (6).webp', 'No Prize (7).webp', 'No Prize (8).webp', 
        'No Prize (9).webp', 'No Prize (10).webp', 'No Prize (11).webp', 'No Prize (12).webp', 
        'No Prize (13).webp', 'No Prize (14).webp', 'No Prize (15).webp', 'No Prize (16).webp', 
        'No Prize (17).webp', 'No Prize (18).webp', 'No Prize (19).webp', 'No Prize (20).webp', 
        'No Prize (21).webp', 'No Prize (22).webp'
    ];
    
    const goldenNoPrizeFiles = [
        'No Prize.webp', 'No Prize (2).webp', 'No Prize (3).webp', 'No Prize (4).webp', 
        'No Prize (5).webp', 'No Prize (6).webp', 'No Prize (7).webp', 'No Prize (8).webp', 
        'No Prize (9).webp', 'No Prize (10).webp', 'No Prize (11).webp', 'No Prize (12).webp', 
        'No Prize (13).webp', 'No Prize (14).webp', 'No Prize (15).webp', 'No Prize (16).webp', 
        'No Prize (17).webp', 'No Prize (18).webp', 'No Prize (19).webp', 'No Prize (20).webp', 
        'No Prize (21).webp', 'No Prize (22).webp'
    ];

    const noPrizeFiles = (type === 'golden') ? goldenNoPrizeFiles : colorfulNoPrizeFiles;

    // Randomize positions for winning icons

    // Randomize positions for winning icons
    const positions = Array.from({length: 16}, (_, i) => i);
    // Shuffle positions
    for (let i = positions.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [positions[i], positions[j]] = [positions[j], positions[i]];
    }

    // Place winning icons
    winningIcons.forEach((prize, idx) => {
        const pos = positions[idx];
        grid[pos] = `${config.path}/${prize.file}`;
    });

    // Fill rest with No Prize
    for (let i = 0; i < 16; i++) {
        if (!grid[i]) {
            const randomNoPrize = noPrizeFiles[Math.floor(Math.random() * noPrizeFiles.length)];
            grid[i] = `${config.path}/${randomNoPrize}`;
        }
    }

    // Format Prize Name String
    let prizeNameStr = isWin ? prizeNames.join(' + ') : '未中奖';
    // If too long, summarize
    if (prizeNames.length > 2) {
        let text = `获得 ${prizeNames.length} 个奖项`;
        if (winAmount > 0) text += `，共 ${winAmount.toLocaleString()} 代币`;
        if (wonGold) text += ' + 金豆';
        prizeNameStr = text;
    }

    res.json({
        success: true,
        grid: grid,
        isWin,
        winAmount,
        wonGold,
        prizeName: prizeNameStr,
        remainingTickets: user.tickets[type],
        totalPendingReward: user.pendingReward,
        consecutiveLosses: user.consecutiveLosses // Return status
    });
});

// 3.5 Claim Pity Reward (Guarantee)
app.post('/api/claim-pity', (req, res) => {
    const { address } = req.body;
    const user = getUser(address);

    if (user.consecutiveLosses >= 10) {
        // Grant 500,000 Tokens
        const refundAmount = 500000;
        user.pendingReward += refundAmount;
        user.consecutiveLosses = 0; // Reset
        
        console.log(`User ${address} claimed Pity Reward: ${refundAmount}`);
        res.json({ success: true, message: '保底奖励已发放！50万代币已存入待领取余额。', newPendingReward: user.pendingReward });
    } else {
        res.status(400).json({ error: '未满足保底条件 (需连续未中奖 10 次)' });
    }
});

// 4. Claim Reward
app.post('/api/claim', async (req, res) => { // Make async
    const { address } = req.body;
    const user = getUser(address);

    if (user.pendingReward <= 0) {
        return res.status(400).json({ error: 'No reward to claim' });
    }

    // Concurrency Lock Check
    if (user.isClaiming) {
        return res.status(429).json({ error: 'Claim in progress, please wait' });
    }
    
    // Set Lock
    user.isClaiming = true;

    const amount = user.pendingReward;
    
    try {
        // Real Blockchain Transfer
        // Ethers v6 compatibility
        const JsonRpcProvider = ethers.JsonRpcProvider || ethers.providers.JsonRpcProvider;
        const parseUnits = ethers.parseUnits || ethers.utils.parseUnits;

        const provider = new JsonRpcProvider(process.env.BSC_RPC_URL);
        // Ensure RECEIVER_PRIVATE_KEY is in .env
        const privateKey = process.env.RECEIVER_PRIVATE_KEY; 
        if (!privateKey) {
            console.error('Missing RECEIVER_PRIVATE_KEY in .env');
            return res.status(500).json({ error: 'Server configuration error' });
        }
        
        const wallet = new ethers.Wallet(privateKey, provider);
        const tokenAddress = process.env.TOKEN_CONTRACT_ADDRESS;
        
        // Minimal ABI for transfer
        const abi = ["function transfer(address to, uint amount) returns (bool)", "function decimals() view returns (uint8)"];
        const contract = new ethers.Contract(tokenAddress, abi, wallet);
        
        const decimals = await contract.decimals();
        const amountWei = parseUnits(amount.toString(), decimals);
        
        console.log(`Processing payout of ${amount} to ${address}...`);
        
        // Send tx
        const tx = await contract.transfer(address, amountWei);
        console.log(`Payout Tx Sent: ${tx.hash}`);
        
        // Wait for confirmation (optional, can be slow)
        // await tx.wait(); 
        
        // Clear pending reward only after successful send (or at least sent)
        user.pendingReward = 0;
        
        res.json({ success: true, message: `已发送 ${amount} 代币到您的钱包`, txHash: tx.hash });
        
    } catch (error) {
        console.error('Payout Failed:', error);
        res.status(500).json({ error: '转账失败，请联系客服' });
    } finally {
        // Release Lock regardless of success/fail
        user.isClaiming = false;
    }
});

// 5. Submit Address for Gold
app.post('/api/submit-address', (req, res) => {
    const { address, shippingInfo } = req.body;
    const user = getUser(address);
    
    if (user.pendingGold <= 0) {
        return res.status(400).json({ error: 'No gold prize pending' });
    }

    // Save shipping info (mock)
    const claimRecord = {
        id: Date.now(),
        timestamp: new Date().toLocaleString('zh-CN'),
        address: address,
        type: shippingInfo.type === 'bnb' ? 'BNB兑换' : '实物发货',
        name: shippingInfo.name || '-',
        phone: shippingInfo.phone || '-',
        shippingAddress: shippingInfo.address || '-',
        bnbAddress: shippingInfo.bnbAddress || '-'
    };

    prizeClaims.unshift(claimRecord); // Add to beginning

    if (shippingInfo.type === 'bnb') {
        console.log(`User ${address} requested BNB exchange for Gold. Addr: ${shippingInfo.bnbAddress}`);
        res.json({ success: true, message: 'BNB 兑换申请已提交，我们将尽快为您处理！' });
    } else {
        console.log(`Shipping Gold to ${address}:`, shippingInfo);
        res.json({ success: true, message: '收货地址已提交，我们将尽快发货！' });
    }
    
    user.pendingGold--;
});

// Get Prize Claims (Admin)
app.get('/api/admin/claims', (req, res) => {
    const pass = req.headers['x-admin-pass'];
    if (pass !== ADMIN_PASS) return res.status(401).json({ error: 'Unauthorized' });
    res.json(prizeClaims);
});

// --- Admin API ---

// Admin Login
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

// Get Trigger Status
app.get('/api/admin/status', (req, res) => {
    // Basic Auth Check (In prod use session/token)
    const auth = req.headers.authorization;
    if (!auth || auth !== `Basic ${Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString('base64')}`) {
         // Allow simple check for this demo without strict header requirement if needed, 
         // but strictly checking basic auth header is better.
         // For simplicity in this specific task context, we might skip strict token checks 
         // if the frontend sends the password every time or just rely on obscurity for this local demo.
         // Let's implement a simple check:
    }
    // We will trust the caller knows the password for now or use a simple shared secret mechanism
    // But better to just check params or headers.
    // Let's use a custom header 'X-Admin-Pass' for simplicity in this script-based setup
    const pass = req.headers['x-admin-pass'];
    if (pass !== ADMIN_PASS) return res.status(401).json({ error: 'Unauthorized' });

    res.json({ nextGoldBeanTrigger });
});

// Toggle Trigger
app.post('/api/admin/trigger-gold-bean', (req, res) => {
    const { enable } = req.body;
    const pass = req.headers['x-admin-pass'];
    if (pass !== ADMIN_PASS) return res.status(401).json({ error: 'Unauthorized' });

    nextGoldBeanTrigger = !!enable;
    console.log(`Admin set Next Gold Bean Trigger to: ${nextGoldBeanTrigger}`);
    res.json({ success: true, nextGoldBeanTrigger });
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Admin User: ${ADMIN_USER}`); // Log for dev convenience
});
