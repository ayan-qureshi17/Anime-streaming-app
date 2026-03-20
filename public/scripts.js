// public/scripts.js

// Utility functions
function fetchAnimeData(apiUrl) {
    return fetch(apiUrl)
        .then(response => response.json())
        .catch(error => console.error('Error fetching data:', error));
}

// DOM Manipulation Functions
function renderAnimeList(animeList) {
    const container = document.getElementById('anime-list');
    container.innerHTML = '';
    animeList.forEach(anime => {
        const animeItem = document.createElement('div');
        animeItem.className = 'anime-item';
        animeItem.innerHTML = `<h2>${anime.title}</h2><p>${anime.description}</p>`;
        container.appendChild(animeItem);
    });
}

// Event Handlers
document.getElementById('fetch-anime').addEventListener('click', () => {
    const apiUrl = 'https://api.example.com/anime'; // Replace with actual API
    fetchAnimeData(apiUrl).then(data => renderAnimeList(data));
});

// Example of how to call the fetch function on load
window.onload = function() {
    document.getElementById('fetch-anime').click();
};
