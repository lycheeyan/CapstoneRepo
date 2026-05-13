const overlay = document.getElementById('data-wall-overlay');
let speciesData = [];
const gridCells = [];

// 1. Load Data
Papa.parse('data/Biodiversity Series/All Species Combined.csv', {
    download: true,
    header: true,
    complete: (results) => {
        speciesData = results.data;
        initDataWall();
    }
});

// 2. Initialize Grid
function initDataWall() {
    for (let i = 0; i < 48; i++) {
        const div = document.createElement('div');
        div.className = 'data-cell';
        overlay.appendChild(div);
        gridCells.push(div);
    }

    // 3. Living Loop
    setInterval(() => {
        const randomCell = gridCells[Math.floor(Math.random() * gridCells.length)];
        if (Math.random() > 0.5) {
            updateCell(randomCell);
        } else {
            clearCell(randomCell);
        }
    }, 400);
}

// 4. Global Color Mapper
function getStatusColor(status) {
    if (!status) return '#555555'; 
    const s = status.toLowerCase();
    if (s.includes('critical')) return '#ff3333';    // Red
    if (s.includes('vulnerable')) return '#ffaa00';  // Amber
    if (s.includes('near threat')) return '#88aaff';  // Orange
    if (s.includes('low concern')) return '#888888'; // Yellow
    if (s.includes('data deficient')) return '#888888'; // Gray
    return '#88888888'; // Default Blue
}

// 5. Update Cell
function updateCell(div) {
    if (speciesData.length === 0) return;
    const entry = speciesData[Math.floor(Math.random() * speciesData.length)];
    
    const color = getStatusColor(entry.status);
    
    // We explicitly style the indicator div using the color
    div.innerHTML = `
        <div class="indicator" style="background-color: ${color}; box-shadow: 0 0 5px ${color};"></div>
        <div class="text-stack">
            <div style="opacity:1.0; font-size: 0.8em; color:#a5ff26;">ID: ${entry.species_id || '---'}</div>
            <div style="opacity:1.0; font-size: 0.8em; color:#a5ff26;">${entry.kingdom || '---'}</div>
            <div style="font-weight:light; color:#fff; margin-top:5px;">${entry.scientific_name}</div>
            <div style="color:#ffffff; font-size: 0.9em;">${entry.common_name || '—'}</div>
            <div style="color:${color}; font-size: 0.8em; margin-top:5px; font-weight:bold;">${entry.status}</div>
        </div>
    `;
    div.style.opacity = '1';
}

// 6. Clear Cell
function clearCell(div) {
    div.style.opacity = '0';
    setTimeout(() => { div.innerHTML = ''; }, 1500); 
}