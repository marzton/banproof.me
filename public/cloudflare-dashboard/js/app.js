document.addEventListener('DOMContentLoaded', () => {
    // Simulate real-time data feeding into the Toll Booth logs
    const logList = document.getElementById('recent-logs');
    
    const mockIPs = ['100.200.200.2', '45.21.99.1', '100.100.100.1', '192.168.1.1', '201.55.12.98'];
    const mockMsgs = [
        'Gold Shore DRS trigger executed',
        'Failed Proof of Agency (Bot)',
        'Wayward Traveler Veo 3.1 video queued',
        'Unauthorized payload signature',
        'SOLEFOODNY Node match confirmed'
    ];

    function addRandomLog() {
        const isVerified = Math.random() > 0.4; // 60% verified
        const ip = mockIPs[Math.floor(Math.random() * mockIPs.length)];
        const msg = mockMsgs[Math.floor(Math.random() * mockMsgs.length)];
        
        const now = new Date();
        const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        const li = document.createElement('li');
        li.className = 'log-item';
        
        li.innerHTML = `
            <span class="log-time">${timeStr}</span>
            <span class="log-ip">${ip} ${isVerified ? '(DePIN)' : '(Datacenter)'}</span>
            <span class="badge ${isVerified ? 'success' : 'danger'}">${isVerified ? 'Verified' : 'Rejected'}</span>
            <span class="log-msg">${msg}</span>
        `;
        
        // Prepend and limit to 10 logs
        logList.insertBefore(li, logList.firstChild);
        if (logList.children.length > 8) {
            logList.removeChild(logList.lastChild);
        }
    }

    // Add a new log every 3 seconds to simulate live traffic
    setInterval(addRandomLog, 3500);

    // Animating the mock bars in the dashboard chart
    const bars = document.querySelectorAll('.mock-bars .bar');
    setInterval(() => {
        bars.forEach(bar => {
            const newHeight = Math.floor(Math.random() * 80) + 10;
            bar.style.height = `${newHeight}%`;
        });
    }, 4000);
});
