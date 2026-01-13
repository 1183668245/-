// Wallet Modal Logic
document.addEventListener('DOMContentLoaded', () => {
    const walletModal = document.getElementById('walletModal');
    const connectBtns = document.querySelectorAll('.btn-connect, .btn-secondary'); // Select all connect buttons
    const closeModal = document.querySelector('.close-modal');

    // Configuration Variables (to be fetched from backend)
    let TOKEN_CONTRACT_ADDRESS = '';
    let RECEIVE_ADDRESS = '';
    let BSC_CHAIN_ID_HEX = '';
    let BSC_CHAIN_ID_DECIMAL = 0;
    let BSC_RPC_URL = '';
    let BSC_EXPLORER_URL = '';
    
    // Standard ERC-20 ABI (Frontend needs this structure locally or fetched, keeping local for simplicity as it's standard)
    const ERC20_ABI = [
        "function balanceOf(address owner) view returns (uint256)",
        "function decimals() view returns (uint8)",
        "function symbol() view returns (string)",
        "function transfer(address to, uint amount) returns (bool)"
    ];

    // Fetch Config from Backend
    async function loadConfig() {
        try {
            const response = await fetch('https://api.guajindou.xyz/api/config');
            if (!response.ok) throw new Error('Failed to load config');
            const config = await response.json();
            
            TOKEN_CONTRACT_ADDRESS = config.tokenContractAddress;
            RECEIVE_ADDRESS = config.receiveAddress;
            BSC_CHAIN_ID_HEX = config.bscChainIdHex;
            BSC_CHAIN_ID_DECIMAL = config.bscChainIdDecimal;
            BSC_RPC_URL = config.bscRpcUrl;
            BSC_EXPLORER_URL = config.bscExplorerUrl;
            
            console.log('Configuration loaded from backend');
        } catch (error) {
            console.error('Error loading config:', error);
            alert('无法连接服务器获取配置，请确保后端服务已启动 (npm start)');
        }
    }

    // Load config immediately
    loadConfig();

    // Check Wallet Status Function
    function checkWallets() {
        const wallets = {
            metamask: typeof window.ethereum !== 'undefined' && window.ethereum.isMetaMask,
            okx: typeof window.okxwallet !== 'undefined',
            trust: typeof window.trustwallet !== 'undefined',
            tokenpocket: typeof window.ethereum !== 'undefined' && window.ethereum.isTokenPocket,
            walletconnect: true // Always available via QR
        };

        for (const [key, isInstalled] of Object.entries(wallets)) {
            const option = document.querySelector(`.wallet-option[data-wallet="${key}"]`);
            if (!option) continue;
            
            const statusEl = option.querySelector('.wallet-status');
            
            if (statusEl) {
                if (isInstalled) {
                    statusEl.textContent = '已就绪';
                    statusEl.style.color = '#4CAF50';
                    option.style.opacity = '1';
                    option.style.cursor = 'pointer';
                } else {
                    statusEl.textContent = '未就绪';
                    statusEl.style.color = '#F44336'; // Red
                    option.style.opacity = '0.6';
                    // Optional: make it unclickable or show download link on click
                }
            }
        }
    }

    // State
    let currentAccount = null;
    let currentTokenBalance = 0;
    const balanceDisplay = document.getElementById('balance-display');
    
    // Scratch Game State
    let currentScratchType = 'colorful'; // 'colorful' or 'golden'
    let isScratching = false;
    let scratchCanvas = document.getElementById('scratchCanvas');
    let scratchCtx = null;
    const balanceValue = document.getElementById('token-balance-value');
    const qualificationMsg = document.getElementById('qualification-msg');

    // My Tickets Button
    const myTicketsBtn = document.getElementById('myTicketsBtn');
    if (myTicketsBtn) {
        myTicketsBtn.addEventListener('click', async () => {
            if (!currentAccount) {
                alert('请先连接钱包！');
                return;
            }
            
            // Check ticket count first
            try {
                const res = await fetch(`https://api.guajindou.xyz/api/user-info?address=${currentAccount}`);
                const data = await res.json();
                const totalTickets = data.tickets.colorful + data.tickets.golden;

                if (totalTickets > 0) {
                    openScratchModal();
                } else {
                    // No tickets, prompt purchase
                    // Determine Ticket Type
                    let ticketType = '彩色刮刮乐';
                    if (currentTokenBalance >= 880000) {
                        ticketType = '金色刮刮乐';
                    }
                    const message = `您当前暂无刮刮乐，是否花费 50,000 代币/张 购买【${ticketType}】？`;
                    
                    // Reset quantity
                    if (purchaseQtyInput) purchaseQtyInput.value = 1;

                    showConfirmModal(message, async () => {
                        const qty = parseInt(purchaseQtyInput.value) || 1;
                        await handlePurchase(ticketType, qty);
                    });
                }
            } catch (e) {
                console.error('Check tickets error:', e);
                openScratchModal(); // Fallback to open modal anyway
            }
        });
    }

    // Scrape Button Logic (Buy Ticket)
    const scrapeBtn = document.getElementById('heroScrapeBtn');
    
    // Confirmation Modal Elements
    const confirmModal = document.getElementById('confirmModal');
    const closeConfirmModal = document.querySelector('.close-confirm-modal');
    const confirmBuyBtn = document.getElementById('confirmBuyBtn');
    const confirmCancelBtn = document.getElementById('confirmCancelBtn');
    const confirmMessage = document.getElementById('confirmMessage');
    const purchaseQtyInput = document.getElementById('purchaseQty');
    const qtyMinusBtn = document.getElementById('qtyMinus');
    const qtyPlusBtn = document.getElementById('qtyPlus');
    let onConfirmAction = null;

    // Quantity Logic
    if (qtyMinusBtn && qtyPlusBtn && purchaseQtyInput) {
        qtyMinusBtn.addEventListener('click', () => {
            let val = parseInt(purchaseQtyInput.value) || 1;
            if (val > 1) purchaseQtyInput.value = val - 1;
        });
        qtyPlusBtn.addEventListener('click', () => {
            let val = parseInt(purchaseQtyInput.value) || 1;
            if (val < 100) purchaseQtyInput.value = val + 1;
        });
    }

    // Helper to close all modals to prevent overlap
    function closeAllModals() {
        if (walletModal) walletModal.classList.remove('show');
        if (confirmModal) confirmModal.classList.remove('show');
        const scratchModal = document.getElementById('scratchModal');
        if (scratchModal) scratchModal.classList.remove('show');
        const shippingModal = document.getElementById('shippingModal');
        if (shippingModal) shippingModal.classList.remove('show');
    }

    // Extract Purchase Logic
    async function handlePurchase(ticketType, quantity = 1) {
        showLoading('正在请求钱包签名...');
        try {
            // Use ethers.js
            const provider = new ethers.providers.Web3Provider(window.ethereum);
            const signer = provider.getSigner();
            const tokenContract = new ethers.Contract(TOKEN_CONTRACT_ADDRESS, ERC20_ABI, signer);

            // Amount to transfer: 50,000 Tokens * Quantity
            const decimals = await tokenContract.decimals();
            const unitPrice = ethers.utils.parseUnits("50000", decimals);
            const amount = unitPrice.mul(quantity); // BigNumber multiplication

            // Send Transaction
            const tx = await tokenContract.transfer(RECEIVE_ADDRESS, amount);
            
            showLoading(`交易已发送，购买 ${quantity} 张，等待确认...`);
            console.log('Transaction sent:', tx.hash);

            // Wait for confirmation
            const receipt = await tx.wait();
            
            if (receipt.status === 1) {
                showLoading('支付确认成功！正在同步数据...');
                // 1. Notify Backend
                // Convert UI type to Backend Code
                const backendType = (ticketType === '金色刮刮乐') ? 'golden' : 'colorful';

                try {
                    const verifyRes = await fetch('https://api.guajindou.xyz/api/verify-payment', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            address: currentAccount,
                            type: backendType,
                            quantity: quantity, // Send quantity
                            txHash: tx.hash
                        })
                    });
                    const verifyData = await verifyRes.json();
                    console.log('Payment verified:', verifyData);
                } catch (err) {
                    console.error('Verification failed:', err);
                    // 即使同步失败，也提示用户，但不阻断流程
                }
                
                hideLoading();

                // Force UI update anyway
                alert('支付成功！即将进入刮奖界面...');
                
                // Refresh Balance
                if (window.ethereum) {
                    fetchTokenBalance(window.ethereum, currentAccount);
                }

                // 2. Open Scratch Modal
                await openScratchModal();
                
            } else {
                hideLoading();
                alert('交易失败！');
            }

        } catch (error) {
            hideLoading();
            console.error('Payment Error:', error);
            if (error.code === 'ACTION_REJECTED') {
                alert('您取消了交易。');
            } else {
                alert('支付失败: ' + (error.reason || error.message));
            }
        }
    }

    if (scrapeBtn) {
        scrapeBtn.addEventListener('click', async () => {
            if (!currentAccount) {
                alert('请先连接钱包！');
                return;
            }

            // Determine Ticket Type
            let ticketType = '彩色刮刮乐';
            if (currentTokenBalance >= 880000) {
                ticketType = '金色刮刮乐';
            }

            // Show Confirmation Modal
            const message = `是否花费 50,000 代币/张 购买【${ticketType}】？`;
            
            // Reset quantity to 1 when opening
            if (purchaseQtyInput) purchaseQtyInput.value = 1;

            showConfirmModal(message, async () => {
                const qty = parseInt(purchaseQtyInput.value) || 1;
                await handlePurchase(ticketType, qty);
            });
        });
    }

    function showConfirmModal(message, onConfirm) {
        closeAllModals(); // Ensure other modals are closed
        if (confirmMessage) confirmMessage.textContent = message;
        if (confirmModal) {
            confirmModal.classList.add('show');
            onConfirmAction = onConfirm;
        }
    }

    function hideConfirmModal() {
        if (confirmModal) {
            confirmModal.classList.remove('show');
            onConfirmAction = null;
        }
    }

    // Confirm Modal Listeners
    if (closeConfirmModal) {
        closeConfirmModal.addEventListener('click', hideConfirmModal);
    }

    if (confirmCancelBtn) {
        confirmCancelBtn.addEventListener('click', hideConfirmModal);
    }

    if (confirmBuyBtn) {
        confirmBuyBtn.addEventListener('click', () => {
            if (onConfirmAction) onConfirmAction();
            hideConfirmModal();
        });
    }

    // Close on outside click (merging with walletModal logic if possible, or separate)
    window.addEventListener('click', (e) => {
        if (e.target == walletModal) {
            walletModal.classList.remove('show');
        }
        if (e.target == confirmModal) {
            hideConfirmModal();
        }
        const scratchModal = document.getElementById('scratchModal');
        if (e.target == scratchModal) {
            scratchModal.classList.remove('show');
        }
    });

    // --- Scratch Game Logic ---

    const scratchModal = document.getElementById('scratchModal');
    const closeScratchModal = document.querySelector('.close-scratch-modal');
    const startScratchBtn = document.getElementById('startScratchBtn');
    const autoScratchBtn = document.getElementById('autoScratchBtn');
    const nextTicketBtn = document.getElementById('nextTicketBtn');
    const claimRewardBtn = document.getElementById('claimRewardBtn');
    const claimPityBtn = document.getElementById('claimPityBtn');
    const pityBar = document.getElementById('pityBar');
    const pityText = document.getElementById('pityText');
    const scratchGrid = document.getElementById('scratchGrid');
    const scratchResultMsg = document.getElementById('scratchResultMsg');

    // Loading Overlay
    const loadingOverlay = document.getElementById('loadingOverlay');
    const loadingText = document.getElementById('loadingText');
    const closeLoadingModal = document.querySelector('.close-loading-modal');

    function showLoading(text) {
        if (loadingText) loadingText.textContent = text;
        if (loadingOverlay) loadingOverlay.classList.add('show');
    }

    function hideLoading() {
        if (loadingOverlay) loadingOverlay.classList.remove('show');
    }

    if (closeLoadingModal) {
        closeLoadingModal.addEventListener('click', hideLoading);
    }
    
    // Shipping Modal
    const shippingModal = document.getElementById('shippingModal');
    const closeShippingModal = document.querySelector('.close-shipping-modal');
    const shippingForm = document.getElementById('shippingForm');
    const bnbForm = document.getElementById('bnbForm');

    // Toggle Prize Form Logic
    window.togglePrizeForm = function(type) {
        const sForm = document.getElementById('shippingForm');
        const bForm = document.getElementById('bnbForm');
        const bnbAddrInput = document.getElementById('bnbAddress');

        if (type === 'physical') {
            if (sForm) sForm.style.display = 'flex';
            if (bForm) bForm.style.display = 'none';
        } else {
            if (sForm) sForm.style.display = 'none';
            if (bForm) bForm.style.display = 'flex';
            // Pre-fill with current connected account
            if (currentAccount && bnbAddrInput) {
                bnbAddrInput.value = currentAccount;
            }
        }
    };

    if (closeScratchModal) {
        closeScratchModal.addEventListener('click', () => {
            scratchModal.classList.remove('show');
        });
    }

    if (closeShippingModal) {
        closeShippingModal.addEventListener('click', () => {
            shippingModal.classList.remove('show');
        });
    }

    async function openScratchModal() {
        const scratchModal = document.getElementById('scratchModal');
        if (!scratchModal) return;
        
        closeAllModals(); // Ensure other modals are closed
        
        scratchModal.classList.add('show');
        await updateUserInfo();
        resetScratchArea();
    }

    async function updateUserInfo() {
        if (!currentAccount) return;
        try {
            const res = await fetch(`https://api.guajindou.xyz/api/user-info?address=${currentAccount}`);
            const data = await res.json();
            
            // Update UI
            const tickets = data.tickets.colorful + data.tickets.golden;
            document.getElementById('remainingTickets').textContent = tickets;
            
            const pendingReward = data.pendingReward;
            document.getElementById('pendingReward').textContent = pendingReward.toLocaleString();
            
            if (pendingReward > 0) {
                claimRewardBtn.style.display = 'inline-block';
            } else {
                claimRewardBtn.style.display = 'none';
            }

            // Update Pity Bar
            const losses = data.consecutiveLosses || 0;
            if (pityBar && pityText) {
                pityText.textContent = `${losses}/10`;
                pityBar.style.width = `${(losses / 10) * 100}%`;
                
                if (losses >= 10) {
                    claimPityBtn.style.display = 'block';
                } else {
                    claimPityBtn.style.display = 'none';
                }
            }

            // Prioritize Golden tickets if mixed, or just use what's available
            if (data.tickets.golden > 0) currentScratchType = 'golden';
            else currentScratchType = 'colorful';
            
            // Update Rules Content
            updateRulesContent(currentScratchType);

            // Check if there is pending gold prize
            if (data.pendingGold > 0) {
                shippingModal.classList.add('show');
            }

        } catch (e) {
            console.error('Fetch user info error:', e);
        }
    }

    function updateRulesContent(type) {
        const titleEl = document.getElementById('scratchTitle');
        const rulesEl = document.getElementById('scratchRulesContent');
        const descPanel = document.querySelector('.scratch-desc-panel'); // Select the panel
        if (!titleEl || !rulesEl) return;

        if (type === 'golden') {
            titleEl.textContent = '金色刮刮乐';
            if (descPanel) {
                descPanel.style.backgroundImage = "url('Materials/金色刮刮乐背景-转换自-png.webp')";
                descPanel.style.backgroundSize = "cover";
                descPanel.style.backgroundPosition = "center";
            }
            rulesEl.innerHTML = `
                <p><strong>最高可刮出百万大奖！</strong></p>
                <p>玩法规则：刮奖区由 16 个刮奖单元组成，每个单元仅用于展示开奖结果，刮出多个不同奖项图案，奖励可叠加。</p>
                <hr style="border: 0; border-top: 1px dashed #ccc; margin: 10px 0;">
                <p><strong>金色刮刮乐奖池：</strong></p>
                <ul style="padding-left: 20px; list-style-type: none;">
                    <li style="display: flex; align-items: center; gap: 5px;"><strong>特等奖：</strong>实物1g金豆奖品，刮出 <img src="Prize Icons/Golden Scratch/Grand Prize.webp" style="height: 24px; vertical-align: middle;"> 图案！</li>
                    <li style="display: flex; align-items: center; gap: 5px;"><strong>一等奖：</strong>100万代币奖品，刮出 <img src="Prize Icons/Golden Scratch/First Prize.webp" style="height: 24px; vertical-align: middle;"> 图案！</li>
                    <li style="display: flex; align-items: center; gap: 5px;"><strong>二等奖：</strong>50万代币奖励，刮出 <img src="Prize Icons/Golden Scratch/Second Prize.webp" style="height: 24px; vertical-align: middle;"> 图案！</li>
                    <li style="display: flex; align-items: center; gap: 5px;"><strong>三等奖：</strong>20万代币奖励，刮出 <img src="Prize Icons/Golden Scratch/Third Prize.webp" style="height: 24px; vertical-align: middle;"> 图案！</li>
                    <li style="display: flex; align-items: center; gap: 5px;"><strong>四等奖：</strong>10万代币奖励，刮出 <img src="Prize Icons/Golden Scratch/Fourth Prize.webp" style="height: 24px; vertical-align: middle;"> 图案！</li>
                    <li style="display: flex; align-items: center; gap: 5px;"><strong>五等奖：</strong>5万代币奖励，刮出 <img src="Prize Icons/Golden Scratch/Fifth Prize.webp" style="height: 24px; vertical-align: middle;"> 图案！</li>
                </ul>
                <hr style="border: 0; border-top: 1px dashed #ccc; margin: 10px 0;">
                <p><strong>特别事项：</strong></p>
                <ol style="padding-left: 20px; font-size: 0.9rem;">
                    <li>刮奖展示为前端动画效果，最终中奖结果以链上合约记录为唯一依据。</li>
                    <li>所有代币奖励将由系统自动从发放至中奖用户钱包。</li>
                    <li>获得实物金豆特等奖的用户，需在指定页面填写收货信息。也可以选择申请等价折现。</li>
                    <li>刮金豆是一种基于链上规则的随机奖励体验，我们不承诺结果，只保证过程透明。</li>
                    <li>刮刮乐为即时消费型产品，面值为 50,000 代币，一经购买不可退款、不可撤销。</li>
                </ol>
            `;
        } else {
            titleEl.textContent = '彩色刮刮乐';
            if (descPanel) {
                descPanel.style.backgroundImage = "url('Materials/彩色刮刮乐背景-转换自-png.webp')";
                descPanel.style.backgroundSize = "cover";
                descPanel.style.backgroundPosition = "center";
            }
            rulesEl.innerHTML = `
                <p><strong>最高可刮出百万大奖！</strong></p>
                <p>玩法规则：刮奖区由 16 个刮奖单元组成，每个单元仅用于展示开奖结果，刮出多个不同奖项图案，奖励可叠加。</p>
                <hr style="border: 0; border-top: 1px dashed #ccc; margin: 10px 0;">
                <p><strong>彩色刮刮乐奖池：</strong></p>
                <ul style="padding-left: 20px; list-style-type: none;">
                    <li style="display: flex; align-items: center; gap: 5px;"><strong>一等奖：</strong>100万代币奖品，刮出 <img src="Prize Icons/Colorful Scratch/First Prize.webp" style="height: 24px; vertical-align: middle;"> 图案！</li>
                    <li style="display: flex; align-items: center; gap: 5px;"><strong>二等奖：</strong>50万代币奖励，刮出 <img src="Prize Icons/Colorful Scratch/Second Prize.webp" style="height: 24px; vertical-align: middle;"> 图案！</li>
                    <li style="display: flex; align-items: center; gap: 5px;"><strong>三等奖：</strong>20万代币奖励，刮出 <img src="Prize Icons/Colorful Scratch/Third Prize.webp" style="height: 24px; vertical-align: middle;"> 图案！</li>
                    <li style="display: flex; align-items: center; gap: 5px;"><strong>四等奖：</strong>10万代币奖励，刮出 <img src="Prize Icons/Colorful Scratch/Fourth Prize.webp" style="height: 24px; vertical-align: middle;"> 图案！</li>
                    <li style="display: flex; align-items: center; gap: 5px;"><strong>五等奖：</strong>5万代币奖励，刮出 <img src="Prize Icons/Colorful Scratch/Fifth Prize.webp" style="height: 24px; vertical-align: middle;"> 图案！</li>
                </ul>
                <hr style="border: 0; border-top: 1px dashed #ccc; margin: 10px 0;">
                <p><strong>特别事项：</strong></p>
                <ol style="padding-left: 20px; font-size: 0.9rem;">
                    <li>刮奖展示为前端动画效果，最终中奖结果以链上合约记录为唯一依据。</li>
                    <li>所有代币奖励将由系统自动从发放至中奖用户钱包。</li>
                    <li>获得实物金豆特等奖的用户，需在指定页面填写收货信息。也可以选择申请等价折现。</li>
                    <li>刮金豆是一种基于链上规则的随机奖励体验，我们不承诺结果，只保证过程透明。</li>
                    <li>刮刮乐为即时消费型产品，面值为 50,000 代币，一经购买不可退款、不可撤销。</li>
                </ol>
            `;
        }
    }

    function resetScratchArea() {
        scratchGrid.innerHTML = '';
        startScratchBtn.style.display = 'inline-block';
        autoScratchBtn.style.display = 'none';
        if (nextTicketBtn) nextTicketBtn.style.display = 'none'; // Hide next button
        scratchResultMsg.textContent = '';
        isResultRevealed = false; // Reset flag
        
        // Reset Canvas
        if (!scratchCanvas) scratchCanvas = document.getElementById('scratchCanvas');
        if (scratchCanvas) {
            scratchCanvas.style.opacity = '1';
            scratchCanvas.style.display = 'none'; // Hide until start
        }
    }

    if (startScratchBtn) {
        startScratchBtn.addEventListener('click', async () => {
            // Call API to Play
            try {
                const res = await fetch('https://api.guajindou.xyz/api/play', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        address: currentAccount,
                        type: currentScratchType
                    })
                });
                
                const data = await res.json();
                
                if (data.error) {
                    alert(data.error);
                    return;
                }

                // Setup Grid
                setupGrid(data.grid);
                
                // Setup Canvas
                setupCanvas();
                
                // Update Buttons
                startScratchBtn.style.display = 'none';
                if (nextTicketBtn) nextTicketBtn.style.display = 'none';
                autoScratchBtn.style.display = 'inline-block';
                autoScratchBtn.textContent = '一键刮开'; // Reset text
                
                // Update Info (Tickets count decreased)
                document.getElementById('remainingTickets').textContent = data.remainingTickets;
                
                // Store result to show later or trigger logic
                window.lastGameResult = data;

            } catch (e) {
                console.error('Play error:', e);
                alert('游戏启动失败');
            }
        });
    }

    function setupGrid(images) {
        scratchGrid.innerHTML = '';
        images.forEach(src => {
            const img = document.createElement('img');
            img.src = src; // Assuming src is relative path from backend
            scratchGrid.appendChild(img);
        });
    }

    function setupCanvas() {
        if (!scratchCanvas) return;
        scratchCanvas.style.display = 'block';
        scratchCanvas.width = scratchCanvas.parentElement.offsetWidth;
        scratchCanvas.height = scratchCanvas.parentElement.offsetHeight;
        
        scratchCtx = scratchCanvas.getContext('2d');
        
        // Fill Silver
        scratchCtx.fillStyle = '#C0C0C0';
        scratchCtx.fillRect(0, 0, scratchCanvas.width, scratchCanvas.height);
        
        // Add Texture/Text
        scratchCtx.fillStyle = '#A0A0A0';
        scratchCtx.font = '24px Arial';
        scratchCtx.textAlign = 'center';
        scratchCtx.fillText('刮开涂层', scratchCanvas.width / 2, scratchCanvas.height / 2);
        
        // Setup Eraser
        scratchCtx.globalCompositeOperation = 'destination-out';
        
        // Events
        let isDrawing = false;
        
        const getPos = (e) => {
            const rect = scratchCanvas.getBoundingClientRect();
            let x, y;
            if (e.touches) {
                x = e.touches[0].clientX - rect.left;
                y = e.touches[0].clientY - rect.top;
            } else {
                x = e.clientX - rect.left;
                y = e.clientY - rect.top;
            }
            return { x, y };
        };
        
        const scratch = (x, y) => {
            scratchCtx.beginPath();
            scratchCtx.arc(x, y, 20, 0, Math.PI * 2);
            scratchCtx.fill();
        };

        const start = (e) => { isDrawing = true; e.preventDefault(); };
        const move = (e) => {
            if (!isDrawing) return;
            e.preventDefault();
            const { x, y } = getPos(e);
            scratch(x, y);
        };
        const end = () => { isDrawing = false; checkScratchCompletion(); };

        scratchCanvas.onmousedown = start;
        scratchCanvas.onmousemove = move;
        scratchCanvas.onmouseup = end;
        
        scratchCanvas.ontouchstart = start;
        scratchCanvas.ontouchmove = move;
        scratchCanvas.ontouchend = end;
    }

    // Helper: Calculate Scratched Percentage
    function getScratchPercentage(ctx, width, height) {
        const imageData = ctx.getImageData(0, 0, width, height);
        const pixels = imageData.data;
        let clearedCount = 0;
        const totalPixels = pixels.length / 4;
        
        // Optimize: Check every 16th pixel (4x4 grid) to improve performance
        const step = 16; 
        let sampleCount = 0;

        for (let i = 0; i < pixels.length; i += 4 * step) {
            // Alpha channel is the 4th value (index i+3)
            // destination-out makes alpha 0
            if (pixels[i + 3] === 0) {
                clearedCount++;
            }
            sampleCount++;
        }

        return (clearedCount / sampleCount) * 100;
    }

    let isResultRevealed = false;

    function checkScratchCompletion(force = false) {
        if (isResultRevealed && !force) return;

        // Threshold: 80%
        const threshold = 80;
        let percent = 0;

        if (!force && scratchCtx && scratchCanvas) {
             percent = getScratchPercentage(scratchCtx, scratchCanvas.width, scratchCanvas.height);
             if (percent < threshold) return; // Not enough scratched
        }

        // Show Result
        const result = window.lastGameResult;
        if (result) {
             // If forced or threshold met, clear entirely for clean look
             if (scratchCanvas) {
                 scratchCanvas.style.transition = 'opacity 0.5s';
                 scratchCanvas.style.opacity = '0';
                 setTimeout(() => {
                    scratchCanvas.style.display = 'none';
                 }, 500);
             }

             if (!scratchResultMsg.textContent) {
                 scratchResultMsg.textContent = result.prizeName;
                 updateUserInfo(); // To refresh pending rewards
                 
                 // Check if user has more tickets
                 const tickets = parseInt(document.getElementById('remainingTickets').textContent) || 0;
                 if (tickets > 0 && nextTicketBtn) {
                     nextTicketBtn.style.display = 'inline-block';
                     autoScratchBtn.style.display = 'none'; // Hide auto scratch since it's done
                 }
             }
             isResultRevealed = true;
        }
    }

    if (nextTicketBtn) {
        nextTicketBtn.addEventListener('click', () => {
             // Reset to initial state instead of auto-starting
             resetScratchArea();
        });
    }

    if (autoScratchBtn) {
        autoScratchBtn.addEventListener('click', () => {
            checkScratchCompletion(true); // Force reveal
        });
    }

    // Helper: Button Loading State
    function setButtonLoading(btn, isLoading, loadingText = '处理中...') {
        if (isLoading) {
            btn.dataset.originalText = btn.textContent;
            btn.disabled = true;
            btn.innerHTML = `<span class="spinner"></span> ${loadingText}`;
        } else {
            btn.disabled = false;
            btn.textContent = btn.dataset.originalText || '领取';
        }
    }

    // Inject Spinner CSS
    const style = document.createElement('style');
    style.innerHTML = `
        .spinner {
            display: inline-block;
            width: 12px;
            height: 12px;
            border: 2px solid rgba(255,255,255,0.3);
            border-radius: 50%;
            border-top-color: #fff;
            animation: spin 1s ease-in-out infinite;
            margin-right: 5px;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
    `;
    document.head.appendChild(style);

    if (claimRewardBtn) {
        claimRewardBtn.addEventListener('click', async () => {
            setButtonLoading(claimRewardBtn, true);
            try {
                const res = await fetch('https://api.guajindou.xyz/api/claim', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ address: currentAccount })
                });
                const data = await res.json();
                if (data.success) {
                    alert(data.message);
                    updateUserInfo();
                    // Refresh Balance
                    if (window.ethereum) {
                         // Add delay for blockchain propagation
                         setTimeout(() => {
                            fetchTokenBalance(window.ethereum, currentAccount);
                         }, 3000);
                    }
                } else {
                    alert(data.error);
                }
            } catch (e) {
                console.error(e);
                alert('网络错误，请重试');
            } finally {
                setButtonLoading(claimRewardBtn, false);
            }
        });
    }

    if (claimPityBtn) {
        claimPityBtn.addEventListener('click', async () => {
            setButtonLoading(claimPityBtn, true);
            try {
                const res = await fetch('https://api.guajindou.xyz/api/claim-pity', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ address: currentAccount })
                });
                const data = await res.json();
                if (data.success) {
                    alert(data.message);
                    updateUserInfo(); // Refresh UI
                } else {
                    alert(data.error);
                }
            } catch (e) {
                console.error(e);
                alert('网络错误');
            } finally {
                setButtonLoading(claimPityBtn, false, '领取保底');
            }
        });
    }

    if (shippingForm) {
        shippingForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const shippingInfo = {
                type: 'physical',
                name: document.getElementById('shipName').value,
                phone: document.getElementById('shipPhone').value,
                address: document.getElementById('shipAddress').value
            };
            
            try {
                const res = await fetch('https://api.guajindou.xyz/api/submit-address', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        address: currentAccount,
                        shippingInfo 
                    })
                });
                const data = await res.json();
                if (data.success) {
                    alert(data.message);
                    shippingModal.classList.remove('show');
                    updateUserInfo();
                }
            } catch (e) {
                alert('提交失败');
            }
        });
    }

    if (bnbForm) {
        bnbForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const bnbAddress = document.getElementById('bnbAddress').value;
            
            try {
                const res = await fetch('https://api.guajindou.xyz/api/submit-address', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        address: currentAccount,
                        shippingInfo: {
                            type: 'bnb',
                            bnbAddress: bnbAddress
                        }
                    })
                });
                const data = await res.json();
                if (data.success) {
                    alert(data.message);
                    shippingModal.classList.remove('show');
                    updateUserInfo();
                }
            } catch (e) {
                alert('提交失败');
            }
        });
    }

    // Open Modal or Disconnect
    connectBtns.forEach(btn => {
        // Skip autoScratchBtn or other non-connect buttons
        if (btn.id === 'autoScratchBtn') return;

        btn.addEventListener('click', (e) => {
            e.preventDefault(); // Prevent default link behavior
            
            if (currentAccount) {
                // Already connected, ask to disconnect
                if (confirm(`已连接: ${currentAccount}\n是否断开连接？`)) {
                    disconnectWallet();
                }
            } else {
                // Not connected, open modal
                closeAllModals(); // Ensure other modals are closed
                checkWallets(); // Check status on open
                walletModal.classList.add('show');
            }
        });
    });

    // Disconnect Function
    function disconnectWallet() {
        currentAccount = null;
        connectBtns.forEach(btn => {
            if (btn.classList.contains('btn-connect')) {
                btn.textContent = 'Connect Wallet';
            } else {
                btn.textContent = '连接钱包';
            }
            btn.style.background = ''; // Reset background
        });
        
        // Hide Balance
        if (balanceDisplay) {
            balanceDisplay.style.display = 'none';
            if (balanceValue) balanceValue.textContent = '0';
        }
        
        // Hide Qualification Msg
        if (qualificationMsg) {
            qualificationMsg.style.display = 'none';
        }

        alert('已断开连接');
    }

    // Close Modal
    if (closeModal) {
        closeModal.addEventListener('click', () => {
            walletModal.classList.remove('show');
        });
    }

    // Close on outside click (Removed to avoid duplication with above block)
    /* window.addEventListener('click', (e) => {
        if (e.target == walletModal) {
            walletModal.classList.remove('show');
        }
        // confirmModal logic is handled above
    }); */

    // Real Connect Function (Global scope for inline onclick)
    window.connectWallet = async function(walletName) {
        let provider = null;
        let downloadUrl = '';

        // Determine Provider
        if (walletName === 'MetaMask') {
            // Priority check for MetaMask to avoid TokenPocket interception if both are installed
            if (window.ethereum && window.ethereum.isMetaMask && !window.ethereum.isTokenPocket) {
                provider = window.ethereum;
            } else if (window.ethereum && window.ethereum.providers) {
                 // Handle multiple injected providers (EIP-6963 style or legacy array)
                 provider = window.ethereum.providers.find(p => p.isMetaMask && !p.isTokenPocket);
            } 
            
            // Fallback: If strict check fails, try generic isMetaMask but warn if behavior is unexpected
            if (!provider && window.ethereum && window.ethereum.isMetaMask) {
                 provider = window.ethereum;
            }

            if (!provider) {
                downloadUrl = 'https://metamask.io/download/';
            }
        } else if (walletName === 'OKX Wallet') {
            if (window.okxwallet) {
                provider = window.okxwallet;
            } else {
                downloadUrl = 'https://www.okx.com/web3';
            }
        } else if (walletName === 'Trust Wallet') {
            if (window.trustwallet) {
                provider = window.trustwallet;
            } else {
                downloadUrl = 'https://trustwallet.com/';
            }
        } else if (walletName === 'TokenPocket') {
             if (window.ethereum && window.ethereum.isTokenPocket) {
                provider = window.ethereum;
            } else {
                downloadUrl = 'https://www.tokenpocket.pro/';
            }
        } else if (walletName === 'WalletConnect') {
            alert('WalletConnect 需要集成 Web3Modal 库，此处仅为 UI 演示。');
            return;
        }

        // Action
        if (provider) {
            try {
                // Request access
                const accounts = await provider.request({ method: 'eth_requestAccounts' });
                const account = accounts[0];
                
                // Only close modal ON SUCCESS
                walletModal.classList.remove('show');
                alert('连接成功！\n地址: ' + account);
                
                // Update State
                currentAccount = account;

                // Fetch Real Token Balance
                if (balanceDisplay) {
                    balanceDisplay.style.display = 'inline-flex';
                    if (balanceValue) balanceValue.textContent = 'Loading...';
                    await fetchTokenBalance(provider, account);
                }

                // Update UI Buttons
                const shortAddr = account.slice(0, 6) + '...' + account.slice(-4);
                connectBtns.forEach(btn => {
                    btn.textContent = shortAddr;
                    btn.style.background = '#4CAF50'; // Green indicates connected
                });
                
                // Show My Tickets Button
                if (myTicketsBtn) myTicketsBtn.style.display = 'inline-block';

            } catch (error) {
                console.error(error);
                // Do NOT close modal on error
                alert('连接失败: ' + error.message);
            }
        } else {
            // Not Installed
            if (confirm(walletName + ' 未就绪（未检测到插件）。\n是否前往下载？')) {
                window.open(downloadUrl, '_blank');
            }
        }
    };

    // Separate function for fetching balance
    async function fetchTokenBalance(provider, account) {
        try {
            // Use ethers.js to interact with the contract
            const ethersProvider = new ethers.providers.Web3Provider(provider);
            
            // Check Network
            const network = await ethersProvider.getNetwork();
            if (network.chainId !== BSC_CHAIN_ID_DECIMAL) {
                try {
                    await provider.request({
                        method: 'wallet_switchEthereumChain',
                        params: [{ chainId: BSC_CHAIN_ID_HEX }],
                    });
                    // Wait a moment for the network switch to propagate
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } catch (switchError) {
                    // This error code indicates that the chain has not been added to MetaMask.
                    if (switchError.code === 4902) {
                        try {
                            await provider.request({
                                method: 'wallet_addEthereumChain',
                                params: [
                                    {
                                        chainId: BSC_CHAIN_ID_HEX,
                                        chainName: 'BNB Smart Chain',
                                        nativeCurrency: {
                                            name: 'BNB',
                                            symbol: 'BNB',
                                            decimals: 18,
                                        },
                                        rpcUrls: [BSC_RPC_URL],
                                        blockExplorerUrls: [BSC_EXPLORER_URL],
                                    },
                                ],
                            });
                            // Wait after adding
                            await new Promise(resolve => setTimeout(resolve, 1000));
                        } catch (addError) {
                            console.error('Add Network Error', addError);
                            alert('无法添加 BSC 网络，请手动切换。');
                            return;
                        }
                    } else {
                        console.error('Switch Network Error', switchError);
                        alert('请手动切换到 BSC 网络以查看余额。');
                        return; // Stop execution if wrong network
                    }
                }
            }

            // Re-initialize provider and signer after potential network switch
            // This fixes "underlying network changed" error because the old provider instance might be stale
            const newEthersProvider = new ethers.providers.Web3Provider(provider);
            // Explicitly force network refresh if needed, but creating new provider is safer
            
            const signer = newEthersProvider.getSigner();
            const tokenContract = new ethers.Contract(TOKEN_CONTRACT_ADDRESS, ERC20_ABI, signer);

            // Fetch data in parallel
            const [balance, decimals, symbol] = await Promise.all([
                tokenContract.balanceOf(account),
                tokenContract.decimals(),
                tokenContract.symbol()
            ]);

            // Format balance
            const formattedBalance = ethers.utils.formatUnits(balance, decimals);
            const floatBalance = parseFloat(formattedBalance);
            currentTokenBalance = floatBalance;
            
            // Display formatted balance (with commas, max 2 decimals)
            if (balanceValue) {
                balanceValue.textContent = floatBalance.toLocaleString(undefined, {
                    minimumFractionDigits: 0, 
                    maximumFractionDigits: 2
                });
            }
            
            // Update unit symbol
            const unitEl = document.querySelector('.balance-unit');
            if (unitEl) unitEl.textContent = symbol;

            // Check Qualification (> 880,000)
            if (qualificationMsg) {
                if (floatBalance > 880000) {
                    qualificationMsg.style.display = 'inline-block';
                } else {
                    qualificationMsg.style.display = 'none';
                }
            }

        } catch (error) {
            console.error("Failed to fetch token balance:", error);
            if (balanceValue) balanceValue.textContent = 'Error';
            alert('无法获取代币余额，请确保您在 BSC 网络上。');
        }
    }

    // Sparkle Effect Logic
    function createSparkles() {
        const container = document.querySelector('.hero-visual-3d');
        if (!container) return;

        const sparkleCount = 15; // Number of concurrent sparkles

        for (let i = 0; i < sparkleCount; i++) {
            const sparkle = document.createElement('div');
            sparkle.classList.add('sparkle');
            
            // Random positioning within the container (relative to image area approx)
            // Adjust ranges to keep sparkles mostly over the image
            const top = Math.random() * 80 + 10; // 10% to 90% height
            const left = Math.random() * 80 + 10; // 10% to 90% width
            
            sparkle.style.top = `${top}%`;
            sparkle.style.left = `${left}%`;
            
            // Random delay and duration variation
            const delay = Math.random() * 5;
            const duration = 1.5 + Math.random() * 1.5; // 1.5s to 3s
            
            sparkle.style.animationDelay = `${delay}s`;
            sparkle.style.animationDuration = `${duration}s`;
            
            container.appendChild(sparkle);
        }
    }

    // Initialize sparkles
    createSparkles();

    // Mascot Logic
    const mascotContainer = document.querySelector('.mascot-container');
    const mascotDialog = document.getElementById('mascotDialog');
    
    const messages = [
        "你好呀，我是金豆灵～<br>每一次刮开，都是一次向命运敲门的声音哦！",
        "要不要告诉我，<br>你这次最想实现的愿望？",
        "愿望有在靠近呢，<br>我已经看到了",
        "每一次刮奖，<br>都是向命运的一次请求。"
    ];

    if (mascotContainer && mascotDialog) {
        mascotContainer.addEventListener('mouseenter', () => {
            // Get random message on hover
            const randomIndex = Math.floor(Math.random() * messages.length);
            const fullText = messages[randomIndex];
            
            // Build HTML with spans for animation
            let html = '';
            let delay = 0;
            const delayIncrement = 0.03; // 30ms delay between chars

            // Regex to split by HTML tags or characters
            const parts = fullText.split(/(<[^>]*>)/g).filter(Boolean);

            parts.forEach(part => {
                if (part.startsWith('<')) {
                    // It's a tag (like <br>), just add it
                    html += part;
                } else {
                    // It's text, wrap chars
                    for (let char of part) {
                        if (char === ' ') {
                            html += ' '; // Preserve spaces
                        } else {
                            html += `<span class="mascot-text-char" style="animation-delay: ${delay}s">${char}</span>`;
                            delay += delayIncrement;
                        }
                    }
                }
            });

            mascotDialog.innerHTML = html;
        });
    }
});
