import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { $el } from "../../scripts/ui.js";
import LoraSmartInfo from './smart_info.js';

var debug = {
    enabled: true,
    log: function(...args) {
        if (this.enabled) {
            console.log(...args);
        }
    }
};

class LoraSidebar {
    constructor(app) {
        const stores = app.getAppStores?.() || {};
        this.canvasStore = stores.canvasStore;
        this.settingStore = stores.settingStore;

        this.app = app;

        //session state changes
        this.sessionKey = 'loraSidebarSession';
        this.stateKey = 'loraSidebarState';
        this.loadingKey = 'loraSidebarContinuousLoadComplete';
        sessionStorage.setItem(this.loadingKey, 'false');
        this.isNewSession = this.checkNewSession();        ;
        this.state = this.isNewSession ? this.getDefaultState() : this.loadState();
        this.isFirstOpen = true; //session hack
        this.defaultCatState = app.extensionManager.setting.get('LoRA Sidebar.General.catState', "Expanded") === "Expanded";
        this.favState = app.extensionManager.setting.get('LoRA Sidebar.General.favState', true);
        this.loraData = [];
        this.filteredData = [];
        this.SorthMethod = app.extensionManager.setting.get('LoRA Sidebar.General.sortMethod', 'AlphaAsc');
        this.minSize = 100;
        this.maxSize = 400;
        this.loadingDelay = 800; // continuous loading delay
        this.initialIndex = 500;
        this.searchDelay = 150;
        this.searchTimeout = null;
        this.batchSize = app.extensionManager.setting.get('LoRA Sidebar.General.batchSize', 500);
        this.nextStartIndex = this.initialIndex + 1;
        this.savedElementSize = app.extensionManager.setting.get('LoRA Sidebar.General.thumbnailSize', 125);
        this.elementSize = this.state.elementSize || this.savedElementSize;
        this.loadingIndicator = this.createLoadingIndicator();
        this.galleryContainer = this.createGalleryContainer();
        this.sizeSlider = this.createSizeSlider();
        this.progressBar = this.createProgressBar(); // Initialize progressBar
        this.loraSidebarWidth = 0;
        this.searchInput = this.createSearchInput();
        this.initialRenderComplete = false;
        this.savedModelFilter = app.extensionManager.setting.get('LoRA Sidebar.General.showModels', "All");
        this.sortModels = app.extensionManager.setting.get('LoRA Sidebar.General.sortModels', 'None');
        this.modelFilter = this.state.modelFilter || this.savedModelFilter;
        this.modelFilterDropdown = this.createModelFilterDropdown();
        this.currentSearchInput = this.state.searchTerm ? this.state.searchTerm.split(/\s+/) : [];
        this.PREDEFINED_TAGS = [
            "character", "style", "celebrity", "concept", "clothing", "poses", 
            "background", "tool", "buildings", "vehicle", "objects", "animal", "assets", "action"
        ];
        this.CUSTOM_TAGS = (app.extensionManager.setting.get('LoRA Sidebar.General.customTags') || "").split(',').map(tag => tag.trim().toLowerCase());
        debug.log("After loading CUSTOM_TAGS:", this.CUSTOM_TAGS);
        this.tagSource = app.extensionManager.setting.get('LoRA Sidebar.General.tagSource', "CivitAI");
        debug.log("Tag source:", this.tagSource);
        this.a1111Style = app.extensionManager.setting.get('LoRA Sidebar.General.a1111Style', false);
        this.UseRG3 = app.extensionManager.setting.get('LoRA Sidebar.General.useRG3', false);
        this.infoPersist = app.extensionManager.setting.get('LoRA Sidebar.General.infoPersist', true);
        this.loadingOverlay = this.createLoadingOverlay();
        this.lastLoadOffset = 0;
        this.searchCount = 0;
        
        this.element = $el("div.lora-sidebar", {
            draggable: false,
        }, [
            $el("div.lora-sidebar-content", {
                draggable: false,
            }, [
                $el("h3", "LoRA Sidebar"),
                this.searchInput,
                this.modelFilterDropdown,
                this.sizeSlider,
                this.loadingIndicator,
                this.galleryContainer,
                this.progressBar,
                this.loadingOverlay
            ])
        ]);

        this.preventDragging();

        this.placeholderUrl = "/lora_sidebar/placeholder";
        this.CatNew = app.extensionManager.setting.get('LoRA Sidebar.General.catNew', false);
        this.FavOpen = app.extensionManager.setting.get('LoRA Sidebar.General.favState', true);

        this.smartEnabled = app.extensionManager.setting.get('LoRA Sidebar.General.smartEnabled', true)

        this.showNSFW = app.extensionManager.setting.get('LoRA Sidebar.NSFW.hideNSFW', true);
        this.nsfwThreshold = app.extensionManager.setting.get('LoRA Sidebar.NSFW.nsfwLevel', 25);
        this.nsfwFolder = app.extensionManager.setting.get('LoRA Sidebar.NSFW.nsfwFolder', true);
        this.nsfwString = app.extensionManager.setting.get('LoRA Sidebar.NSFW.nsfwString', "NSFW");

        this.addStyles().catch(console.error);
        //this.lastProcessed = { newVal: undefined, oldVal: undefined }; // I NEED TO REFACTOR THIS

        api.addEventListener("lora_process_progress", this.updateProgress.bind(this));
    }

    async addStyles() {
        try {
            const response = await fetch('./extensions/ComfyUI_LoRA_Sidebar/css/lora-sidebar.css');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const css = await response.text();
            const styleElement = document.createElement('style');
            styleElement.textContent = css;
            document.head.appendChild(styleElement);
        } catch (error) {
            console.error('Error loading LoRA Sidebar styles:', error);
        }
    }

    // session state stuff
    checkNewSession() {
        const lastSession = sessionStorage.getItem(this.sessionKey);
        const currentSession = Date.now().toString();
        sessionStorage.setItem(this.sessionKey, currentSession);
        return !lastSession || lastSession !== currentSession;
    }

    getDefaultState() {
        return {
            searchTerm: '',
            modelFilter: this.savedModelFilter,
            elementSize: this.savedElementSize,
            categoryStates: {},
            scrollPosition: 0,
            totalLoaded: 0
        };
    }

    saveState() {
        sessionStorage.setItem(this.stateKey, JSON.stringify(this.state));
    }

    loadState() {
        const savedState = sessionStorage.getItem(this.stateKey);
        return savedState ? JSON.parse(savedState) : this.getDefaultState();
    }

    getTotalLoadedItems() {
        const containers = this.galleryContainer.querySelectorAll('.lora-items-container');
        let total = 0;
        containers.forEach(container => {
            total += container.children.length;
        });
        return total;
    }

    ///////

    getActiveTags() {
        return this.tagSource === 'CivitAI' ? this.PREDEFINED_TAGS : this.CUSTOM_TAGS;
    }

    setNSFWThreshold(threshold) {
        this.nsfwThreshold = threshold;
    }

    isNSFW(lora) {
        return (lora.nsfw && this.nsfwThreshold < 50) || (lora.nsfwLevel && lora.nsfwLevel > this.nsfwThreshold);
    }

    preventDragging() {
        const makeNotDraggable = (element) => {
            // Skip elements with class lora-overlay
            if (!element.classList?.contains('lora-overlay')) {
                element.draggable = false;
                // Recursively process all children
                Array.from(element.children).forEach(child => makeNotDraggable(child));
            }
        };
    
        // Start with the sidebar element
        makeNotDraggable(this.element);
    }    

    createSizeSlider() {
        this.sizeSlider = $el("input.lora-size-slider", {
            type: "range",
            min: this.minSize,
            max: this.maxSize,
            value: this.elementSize,
            draggable: false,
            oninput: (e) => {
                this.elementSize = parseInt(e.target.value);
                this.updateGalleryLayout();
            }
        });
        return this.sizeSlider;
    }

    createModelFilterDropdown() {
        const filterOptions = ['All', 'Pony', 'Flux', 'SD 3.5', 'Illustrious', 'SDXL', 'SD 1.5', 'Custom + Other'];
        const dropdown = $el("select.model-filter-dropdown", {
            onchange: (e) => this.handleModelFilter(e.target.value)
        });
    
        filterOptions.forEach(option => {
            const optionElement = $el("option", { 
                value: option, 
                textContent: option,
                selected: option === this.state.modelFilter
            });
            dropdown.appendChild(optionElement);
        });
    
        return dropdown;
    }

    updateGalleryLayout() {
        const itemWidth = `${this.elementSize}px`;
    
        this.element.querySelectorAll('.lora-item').forEach(item => {
            item.style.width = itemWidth;
            // The height will be automatically set by the aspect-ratio in CSS
        });
    
        // Update the grid-template-columns for all lora-items-container
        this.element.querySelectorAll('.lora-items-container').forEach(container => {
            container.style.gridTemplateColumns = `repeat(auto-fill, minmax(${itemWidth}, 1fr))`;
        });
    }

    createSearchInput() {
        const searchContainer = $el("div.search-container", [
            $el("input.search-input", {
                type: "text",
                placeholder: "Search name, tags, model, etc.",
                value: this.state.searchTerm,
                oninput: (e) => this.debouncedSearch(e.target.value)
            }),
            $el("button.search-clear", {
                innerHTML: "&#x2715;",
                title: "Clear search",
                onclick: () => {
                    const searchInput = this.element.querySelector('.search-input');
                    searchInput.value = '';
                    this.debouncedSearch('');
                }
            })
        ]);
    
        return searchContainer;
    }

    debounce(func, delay) {
        let debounceTimer;
        return function (...args) {
            const context = this;
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => func.apply(context, args), delay);
        };
    }

    debouncedSearch(searchInput) {
        // Clear any existing timeout
        if (this.searchTimeout) {
            clearTimeout(this.searchTimeout);
        }

        // Set a new timeout
        this.searchTimeout = setTimeout(() => {
            this.handleSearch(searchInput);
        }, this.searchDelay);
    }

    createLoadingIndicator() {
        return $el("div.loading-indicator", {
            style: {
                display: "none",
                textAlign: "center",
                padding: "20px"
            }
        }, [
            $el("p", "Processing LoRAs..."),
            $el("progress")
        ]);
    }

    createGalleryContainer() {
        this.galleryContainer = $el("div.lora-gallery-container", {
            draggable: false,            
        });
        return this.galleryContainer;
    }

    saveScrollPosition() {
        const sidebarContentContainer = document.querySelector('.sidebar-content-container');
        if (sidebarContentContainer) {
            this.state.scrollPosition = sidebarContentContainer.scrollTop;
            this.saveState();
        }
    }

    handleSearch(searchInput) {
        const newSearchInput = searchInput.toLowerCase().split(/\s+/).filter(term => term.length > 0);
        
        if (JSON.stringify(this.currentSearchInput) !== JSON.stringify(newSearchInput) ||
            searchInput === this.currentSearchInput.join(' ')) {
            
            this.currentSearchInput = newSearchInput;
            
            // Use your existing fast filtering logic
            this.filteredData = this.loraData.filter(lora => {
                // NSFW filter - always apply if showNSFW is false
                if (!this.showNSFW && this.isNSFW(lora)) {
                    return false;
                }
    
                // Search term filter
                const matchesSearch = this.currentSearchInput.length === 0 || this.currentSearchInput.every(term => {
                    const nameMatch = lora.name && lora.name.toLowerCase().includes(term);
                    const tagMatch = Array.isArray(lora.tags) && lora.tags.some(tag => 
                        tag.toLowerCase().includes(term)
                    );
                    const trainedWordsMatch = Array.isArray(lora.trained_words) && 
                        lora.trained_words.some(word => word.toLowerCase().includes(term));
                    const baseModelMatch = lora.baseModel && lora.baseModel.toLowerCase().includes(term);
                    const subdirMatch = lora.subdir && lora.subdir.toLowerCase().includes(term);
                    const typeMatch = lora.type && lora.type.toLowerCase().includes(term);
    
                    return nameMatch || tagMatch || trainedWordsMatch || 
                           baseModelMatch || subdirMatch || typeMatch;
                });
    
                // Model filter
                const matchesModelFilter = this.modelFilter === 'All' || 
                                         this.matchesModelFilter(lora, this.modelFilter);
    
                return matchesSearch && matchesModelFilter;
            });
    
            // Reset gallery and render filtered results
            this.galleryContainer.innerHTML = '';
            this.renderLoraGallery(0, this.batchSize);

            // If we're searching and have less than 500 items showing, load more from expanded categories
            if (this.currentSearchInput.length > 0) {
                const visibleCount = this.galleryContainer.querySelectorAll('.lora-item').length;
                if (visibleCount < 500) {
                    // Find expanded categories that need more items
                    const expandedCategories = Array.from(this.galleryContainer.querySelectorAll('.lora-category'))
                        .filter(category => {
                            const container = category.querySelector('.lora-items-container');
                            return container &&
                                window.getComputedStyle(container).display !== 'none' &&
                                container.dataset.pendingLorasData;
                        });

                    // Load more from each category until we hit 500
                    for (const category of expandedCategories) {
                        if (this.galleryContainer.querySelectorAll('.lora-item').length >= 500) break;
                        
                        const container = category.querySelector('.lora-items-container');
                        const categoryName = category.getAttribute('data-category');
                        const loadedCount = container.children.length;

                        // Get filtered items for this category
                        const categoryItems = this.filteredData.filter(lora => 
                            !lora.favorite && 
                            (!lora.is_new || !this.CatNew) && 
                            this.getCategoryForLora(lora) === categoryName
                        );

                        // Calculate remaining items to load
                        const remainingItems = categoryItems.slice(loadedCount);
                        
                        if (remainingItems.length > 0) {
                            this.createLoraElementsForCategory(container, remainingItems);
                            
                            // Update pending data
                            if (remainingItems.length > container.children.length - loadedCount) {
                                const stillPending = remainingItems.slice(container.children.length - loadedCount);
                                container.dataset.pendingLorasData = JSON.stringify(stillPending);
                            } else {
                                delete container.dataset.pendingLorasData;
                            }
                        }
                    }
                }
            }
    
            this.state.searchTerm = searchInput;
            this.saveState();
        }
    }

    countItemsInClosedCategories() {
        let count = 0;
        const categories = this.galleryContainer.querySelectorAll('.lora-category');
        categories.forEach(category => {
            const lorasContainer = category.querySelector('.lora-items-container');
            if (lorasContainer.style.display === 'none') {
                // For pending loras, get count from dataset
                if (lorasContainer.dataset.pendingLoras) {
                    count += JSON.parse(lorasContainer.dataset.pendingLoras).length;
                } else {
                    count += lorasContainer.children.length;
                }
            }
        });
        return count;
    }

    loraPathCalc(loraData) {
        return `${loraData.path}${loraData.path ? "/" : ""}${loraData.filename.split("/").pop()}`;
    }
    
    loraPathCalcUpdate(loraData) {
        debug.log("loraPathCalcUpdate", loraData);
        return `${loraData.subdir}/${loraData.filename}`;
    }

    sanitizeHTML(html) {
        // Create a temporary element
        const temp = document.createElement('div');
        temp.innerHTML = html;
        
        // Remove any script tags
        const scripts = temp.getElementsByTagName('script');
        while (scripts[0]) {
            scripts[0].parentNode.removeChild(scripts[0]);
        }
        
        // Remove any style tags
        const styles = temp.getElementsByTagName('style');
        while (styles[0]) {
            styles[0].parentNode.removeChild(styles[0]);
        }
        
        // Remove any on* attributes (onclick, onmouseover, etc.)
        const all = temp.getElementsByTagName('*');
        for (let i = 0; i < all.length; i++) {
            const attrs = all[i].attributes;
            for (let j = attrs.length - 1; j >= 0; j--) {
                if (attrs[j].name.startsWith('on')) {
                    all[i].removeAttribute(attrs[j].name);
                }
            }
        }
        
        // Return the sanitized HTML
        return temp.innerHTML;
    }
        
    matchesModelFilter(lora, filter) {
        const baseModel = (lora.baseModel || '').toLowerCase();
        switch (filter) {
            case 'Pony':
                return baseModel.includes('pony');
            case 'Flux':
                return baseModel.includes('flux');
            case 'SD 3.5':
                return baseModel.includes('sd') && baseModel.includes('3.5');
            case 'Illustrious':
                return baseModel.includes('illustrious');
            case 'SDXL':
                return baseModel.includes('sdxl');
            case 'SD 1.5':
                return baseModel.includes('sd') && baseModel.includes('1.5');
            case 'Custom + Other':
                return !['pony', 'flux', 'sdxl', 'illustrious'].some(model => baseModel.includes(model)) &&
                !(baseModel.includes('sd') && (baseModel.includes('1.5') || baseModel.includes('3.5')));
            default:
                return true;
        }
    }
    
    handleModelFilter(filterValue) {
        this.modelFilter = filterValue;
        this.state.modelFilter = filterValue;
        this.handleSearch(this.state.searchTerm);
        this.saveState();
    }

    async checkUnprocessedLoras() {
        debug.log("Checking for unprocessed LoRAs...");
        try {
            const response = await api.fetchApi('/lora_sidebar/unprocessed_count');
            debug.log("Response received:", response);
            if (response.ok) {
                const data = await response.json();
                debug.log("Unprocessed LoRAs data:", data);
                return {
                    unprocessedCount: data.unprocessed_count,
                    newCount: data.new_loras.length,
                    movedCount: data.moved_loras.length,
                    missingCount: data.missing_loras.length,
                    localMetadata: data.local_metadata,
                    remoteMetadata: data.remote_metadata
                };
            }
            
            console.error("Error response:", response.status, response.statusText);

        } catch (error) {
            console.error("Error checking unprocessed LoRAs:", error);
        }
        return {
            unprocessedCount: 0,
            newCount: 0,
            movedCount: 0,
            missingCount: 0,
            localMetadata: 0,
            remoteMetadata: 0
        };
    }

    showUnprocessedLorasPopup(counts) {
        return new Promise(async (resolve) => {
            // First, check if processing is already running
            let isProcessing = false;
            try {
                const processingResponse = await fetch('/lora_sidebar/is_processing');
                if (processingResponse.ok) {
                    const processingData = await processingResponse.json();
                    isProcessing = processingData.is_processing;
                }
            } catch (error) {
                console.error("Error checking processing status:", error);
            }

            // If processing is already in progress, don't show the popup
            if (isProcessing) {
                debug.log("Processing already in progress, skipping prompt.");
                resolve(false);  // Automatically resolve as "no processing"
                return;
            }

            // Fetch the estimate from the backend
            let estimatedTimeStr = "Calculating...";
            let unprocessedLoras = 0;
            let newLoras = 0;
            let movedLoras = 0;
            let missingLoras = 0;
            let localLoras = 0;
            let remoteLoras = 0;

            try {
                const response = await fetch(`/lora_sidebar/estimate?new=${counts.new}&moved=${counts.moved}&missing=${counts.missing}&local=${counts.local}&remote=${counts.remote}`);
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                const data = await response.json();
                const { total_unprocessed_loras, new_loras, moved_loras, missing_loras, local_loras, remote_loras, estimated_time_minutes } = data;
                
                // Use the estimated_time_minutes directly as it already includes the units
                estimatedTimeStr = `${estimated_time_minutes}`;
                unprocessedLoras = `${total_unprocessed_loras}`;
                newLoras = `${new_loras}`;
                movedLoras = `${moved_loras}`;
                missingLoras = `${missing_loras}`;
                localLoras = `${local_loras}`;
                remoteLoras = `${remote_loras}`;

            } catch (error) {
                console.error("Error fetching estimate:", error);
                estimatedTimeStr = "Unavailable";
            }

            const popup = $el("div.lora-popup", {
                style: {
                    position: "fixed",
                    top: "50%",
                    left: "50%",
                    transform: "translate(-50%, -50%)",
                    backgroundColor: "#333",
                    padding: "20px",
                    borderRadius: "10px",
                    boxShadow: "0 0 10px rgba(0,0,0,0.5)",
                    zIndex: "1000",
                    color: "#ccc",
                    maxWidth: "400px",
                    textAlign: "center"
                }
            }, [
                $el("h3", "Process LoRAs"),
                $el("p", `Found ${unprocessedLoras} LoRAs to process.`),
                $el("p", `Of these detected ${newLoras} are New, ${movedLoras} have Moved, and ${missingLoras} are Missing. ${localLoras} LoRAs have local data we can use and ${remoteLoras} will require remote API calls.`),
                $el("p", `Estimated processing time: ${estimatedTimeStr}.`),
                $el("p", "This process can take a lot of time with large amounts of remote LoRAs. (This is for your protection so CivitAI doesn't ban your IP!) Local metadata, speeds things up considerably."),
                $el("p", "You are free to close the sidebar and use Comfy while it runs, but WFs might run very slowly. If you need to quit, progress is saved and can be resumed later."),
                $el("p", "If this is asking to process older LoRA files again, it means I had to make a data change. (Sorry) You can Cancel this process for now but you won't have new features (or LoRAs) until you hit OK."),
                $el("div", {
                    style: {
                        display: "flex",
                        justifyContent: "space-around",
                        marginTop: "20px"
                    }
                }, [
                    $el("button", {
                        textContent: "OK",
                        onclick: () => {
                            document.body.removeChild(popup);
                            resolve(true);
                        },
                        style: {
                            padding: "10px 20px",
                            cursor: "pointer",
                            backgroundColor: "#4CAF50",
                            color: "white",
                            border: "none",
                            borderRadius: "5px"
                        }
                    }),
                    $el("button", {
                        textContent: "Cancel",
                        onclick: () => {
                            document.body.removeChild(popup);
                            resolve(false);
                        },
                        style: {
                            padding: "10px 20px",
                            cursor: "pointer",
                            backgroundColor: "#f44336",
                            color: "white",
                            border: "none",
                            borderRadius: "5px"
                        }
                    })
                ])
            ]);
            document.body.appendChild(popup);
        });
    }

    createProgressBar() {
        const container = document.createElement('div');
        container.style.display = 'none';
        container.style.width = '100%';
        container.style.marginTop = '10px';

        const progress = document.createElement('progress');
        progress.style.width = '100%';
        progress.max = 100;
        progress.value = 0;

        // counter
        const progressText = document.createElement('div');
        progressText.style.textAlign = 'center';
        progressText.style.marginTop = '5px';
        progressText.style.fontSize = '12px';
        progressText.style.color = '#666';

        container.appendChild(progress);
        container.appendChild(progressText);
        return container;
    }

    updateProgress(event) {
        const { progress, completed, total } = event.detail;
        this.progressBar.style.display = 'block';
        const progressBar = this.progressBar.querySelector('progress');
        const progressText = this.progressBar.querySelector('div');
        
        progressBar.value = progress;
        progressText.textContent = `Processing: ${completed}/${total}`;
    }

    async processLoras() {
        this.progressBar.style.display = 'block';
        try {
            const response = await api.fetchApi('/lora_sidebar/process');
            if (response.ok) {
                const result = await response.json();
                debug.log("LoRAs processed successfully", result);
            } else {
                console.error("Error processing LoRAs:", response.status, response.statusText);
            }
        } catch (error) {
            console.error("Error processing LoRAs:", error);
        } finally {
            this.progressBar.style.display = 'none';
        }
    }

    createLoadingOverlay() {
        const overlay = $el("div.loading-overlay", {
            style: {
                display: "none"
            }
        }, [
            $el("div.spinner-container", [
                $el("div.spinner"),
                $el("h2", { 
                    textContent: "Loading LoRAs...",
                    className: "loading-text"
                }),
                $el("p", { 
                    textContent: "This can take some time if you're generating or just processed new LoRAs.",
                    className: "loading-text"
                }),
                $el("p", { 
                    textContent: "If it always takes a long time, you should play with the LoRA Loading Batch Size in the sidebar settings.",
                    className: "loading-text"
                })
            ])
        ]);
        return overlay;
    }

    async toggleFavorite(lora) {
        try {
            const response = await api.fetchApi('/lora_sidebar/toggle_favorite', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: lora.id })
            });
    
            if (response.ok) {
                // Update in-memory data
                const loraInData = this.loraData.find(l => l.id === lora.id);
                if (loraInData) {
                    const wasInFavorites = loraInData.favorite;
                    loraInData.favorite = !loraInData.favorite;
    
                    // Update filtered data if it exists
                    const loraInFiltered = this.filteredData.find(l => l.id === lora.id);
                    if (loraInFiltered) {
                        loraInFiltered.favorite = loraInData.favorite;
                    }
    
                    // Get category info update from BE
                    const result = await response.json();
                    if (result.categoryInfo) {
                        this.categoryInfo = result.categoryInfo;
                    }
    
                    // Update just the affected categories
                    const favoritesCategory = this.galleryContainer.querySelector(
                        '.lora-category[data-category="Favorites"]'
                    );
                    const originalCategory = this.galleryContainer.querySelector(
                        `.lora-category[data-category="${this.getCategoryForLora(lora)}"]`
                    );
    
                    // Update Favorites category
                    if (favoritesCategory) {
                        const favorites = this.filteredData.filter(l => l.favorite);
                        const container = favoritesCategory.querySelector('.lora-items-container');
                        const isExpanded = container && 
                            window.getComputedStyle(container).display !== 'none';
    
                        if (isExpanded) {
                            container.innerHTML = '';
                            this.createLoraElementsForCategory(container, favorites);
                        } else {
                            // update pending data when minimized
                            container.dataset.pendingLorasData = JSON.stringify(favorites);
                        }

                        // Update pending data if any
                        const currentCount = container.children.length;
                        if (favorites.length > currentCount) {
                            const pendingItems = favorites.slice(currentCount);
                            container.dataset.pendingLoras = JSON.stringify(
                                pendingItems.map(i => i.id)
                            );
                            container.dataset.pendingLorasData = JSON.stringify(pendingItems);
                        }
    
                        // Update count
                        const countDisplay = favoritesCategory.querySelector('.category-count');
                        if (countDisplay) {
                            countDisplay.textContent = `${container.children.length}/${favorites.length}`;
                        }
                    }
    
                    // Update original category if it exists
                    if (originalCategory) {
                        const container = originalCategory.querySelector('.lora-items-container');
                        if (container) {
                            const categoryName = originalCategory.getAttribute('data-category');
                            const categoryLoras = this.filteredData.filter(l => 
                                !l.favorite && 
                                (!l.is_new || !this.CatNew) && 
                                this.getCategoryForLora(l) === this.getCategoryForLora(lora)
                            );
    
                            const isExpanded = window.getComputedStyle(container).display !== 'none';
                            if (isExpanded) {
                                // Only reload the currently loaded items
                                const currentCount = container.children.length;
                                container.innerHTML = '';
                                this.createLoraElementsForCategory(
                                    container, 
                                    categoryLoras.slice(0, currentCount)
                                );
    
                                // Update pending data if any
                                if (categoryLoras.length > currentCount) {
                                    const pendingItems = categoryLoras.slice(currentCount);
                                    container.dataset.pendingLoras = JSON.stringify(
                                        pendingItems.map(i => i.id)
                                    );
                                    container.dataset.pendingLorasData = JSON.stringify(pendingItems);
                                }
                            }
    
                            // Update count
                            // Get the original total from categoryInfo
                            const totalInCategory = this.categoryInfo?.[categoryName]?.total || categoryLoras.length;


                            const countDisplay = originalCategory.querySelector('.category-count');
                            if (countDisplay) {
                                countDisplay.textContent = 
                                    `${container.children.length}/${totalInCategory}`;
                            }
                        }
                    }
    
                    this.showToast("success", "Favorite Updated", 
                        `${lora.name} has been ${loraInData.favorite ? 'added to' : 'removed from'} favorites.`);
                }
            }
        } catch (error) {
            console.error("Error toggling favorite:", error);
            this.showToast("error", "Update Failed", 
                `Failed to update favorite status for ${lora.name}.`);
        }
    }

    // Helper function for category determination
    getCategoryForLora(lora) {
        if (this.sortModels === 'Tags') {
            if (lora.tags) {
                const activeTags = this.getActiveTags();
                const matchingTag = activeTags.find(tag => lora.tags.includes(tag));
                if (matchingTag) return matchingTag;
            }
            return 'Unsorted';
        } else if (this.sortModels === 'Subdir') {
            return lora.subdir ? lora.subdir.split('\\').pop() : 'Unsorted';
        }
        return 'All LoRAs';
    }

    async loadLoraData(offset = 0, limit = this.batchSize) {
        try {
            const sortPreference = this.SorthMethod || 'AlphaAsc';
            const url = `/lora_sidebar/data?` + new URLSearchParams({
                offset: offset,
                limit: limit,
                sort: sortPreference,
                nsfw_folder: this.nsfwFolder,
                nsfw_string: this.nsfwString
            });
    
            const response = await api.fetchApi(url);
            if (response.ok) {
                const data = await response.json();
                if (data && data.loras) {
                    // msfw check
                    if (this.nsfwFolder) {
                        data.loras = data.loras.map(lora => {
                            if (lora.subdir && lora.subdir.toLowerCase().includes('nsfw')) {
                                return {
                                    ...lora,
                                    nsfw: true,
                                    nsfwLevel: 100
                                };
                            }
                            return lora;
                        });
                    }
                    // Initial load
                    if (offset === 0) {
                        this.loraData = data.loras;
                        this.filteredData = this.loraData;
                        
                        // Store category info on initial load
                        if (data.categoryInfo) {
                            this.categoryInfo = data.categoryInfo;
                            debug.log("Updated category info:", this.categoryInfo);
                        }
    
                        // Initial render with proper limit
                        const initialRenderCount = Math.min(500, data.loras.length);
                        this.renderLoraGallery(0, initialRenderCount);
    
                        // Update favorites if provided (first batch only)
                        if (data.favorites) {
                            debug.log("Updated favorites from backend");
                            this.favorites = data.favorites;
                        }
    
                        // Only continue loading if there's more data
                        if (data.hasMore) {
                            let currentOffset = limit;
                            let hasMore = data.hasMore;
                            
                            while (hasMore) {
                                const nextUrl = `/lora_sidebar/data?` + new URLSearchParams({
                                    offset: currentOffset,
                                    limit: limit,
                                    sort: sortPreference,
                                    nsfw_folder: this.nsfwFolder
                                });

                                const nextResponse = await api.fetchApi(nextUrl);
                                if (nextResponse.ok) {
                                    const nextData = await nextResponse.json();
                                    if (nextData && nextData.loras) {
                                        // nsfw check 2
                                        if (this.nsfwFolder) {
                                            nextData.loras = nextData.loras.map(lora => {
                                                if (lora.subdir && lora.subdir.toLowerCase().includes('nsfw')) {
                                                    return {
                                                        ...lora,
                                                        nsfw: true,
                                                        nsfwLevel: 100
                                                    };
                                                }
                                                return lora;
                                            });
                                        }

                                        // Carefully append new data
                                        this.loraData = [...this.loraData, ...nextData.loras];
                                        
                                        // Update filtered data only if we're not currently searching
                                        if (!this.currentSearchInput.length) {
                                            this.filteredData = this.loraData;
                                        }
                                        
                                        if (nextData.categoryInfo) {
                                            this.categoryInfo = {
                                                ...this.categoryInfo,
                                                ...nextData.categoryInfo
                                            };
                                            debug.log("Updated category info:", this.categoryInfo);
                                        }
                                        
                                        currentOffset += limit;
                                        hasMore = nextData.hasMore;
                                    }
                                }
                            }
                        }
                    } else {
                        // Handle subsequent batch loads (scrolling)
                        this.loraData = [...this.loraData, ...data.loras];
                        
                        // Only update filtered data if not searching
                        if (!this.currentSearchInput.length) {
                            this.filteredData = this.loraData;
                            this.renderLoraGallery(this.loraData.length - data.loras.length, data.loras.length);
                        }
                        
                        // Update category info if provided
                        if (data.categoryInfo) {
                            this.categoryInfo = {
                                ...this.categoryInfo,
                                ...data.categoryInfo
                            };
                            debug.log("Updated category info:", this.categoryInfo);
                        }
                    }
                    
                    // Store pagination info
                    this.hasMore = data.hasMore;
                    this.totalCount = data.totalCount;
                    this.favoritesManuallyClosed = false; // Reset on full refresh
                    
                    debug.log(`Loaded ${data.loras.length} LoRAs, total: ${this.loraData.length}, hasMore: ${this.hasMore}`);
                }
            }
        } catch (error) {
            console.error("Error loading LoRA data:", error);
        }
    }
    
    renderLoraGallery(startIndex = 0, count = 500) {
        try {
            // Reduce count to total loras we're dealing with
            let totalLoras = this.filteredData.length
            debug.log("Total Loras:",totalLoras);
            debug.log("Count:",count);
            if (count > totalLoras) {
                count = totalLoras;
                debug.log("Batch larger than LoRA list, setting size to",count);
            }
    
            if (startIndex === 0) {
                this.galleryContainer.innerHTML = '';
                const favorites = this.filteredData.filter(lora => lora.favorite);
                let remainingItems = Math.min(count, 250 + favorites.length); // TODO change this hard set to something that uses batch size like 10%?
                debug.log("We've got this many loras to work with",remainingItems);
    
                // Render Favorites
                if (favorites.length > 0) {
                    const favoritesCategory = this.createCategoryElement("Favorites", favorites);
                    if (favoritesCategory) {
                        this.galleryContainer.appendChild(favoritesCategory);
                        // Only count against budget if expanded
                        const favsContainer = favoritesCategory.querySelector('.lora-items-container');
                        if (favsContainer && window.getComputedStyle(favsContainer).display !== 'none') {
                            remainingItems -= favorites.length;
                        }
                    }
                }
    
                // Render New Items
                if (remainingItems > 0) {
                    const newItems = this.filteredData.filter(lora => 
                        !lora.favorite && lora.is_new && this.CatNew
                    );
                    if (newItems.length > 0) {
                        const newCategory = this.createCategoryElement("New", 
                            newItems.slice(0, remainingItems));
                        if (newCategory) {
                            this.galleryContainer.appendChild(newCategory);
                            remainingItems -= Math.min(newItems.length, remainingItems);
                        }
                    }
                }
    
                // Get remaining items excluding favorites and new
                const remainingLoras = this.filteredData.filter(lora => 
                    !lora.favorite && (!lora.is_new || !this.CatNew)
                );
    
                // Handle the rest based on sort mode
                if (this.sortModels === 'None') {
                    // Simple rendering without categories
                    const allLorasCategory = this.createCategoryElement("All LoRAs", 
                        remainingLoras.slice(0, Math.min(500, remainingItems)));
                    if (allLorasCategory) {
                        this.galleryContainer.appendChild(allLorasCategory);
                    }
                } else {
                    // Create categories with minimum 1 item if possible
                    let categorizedLoras = new Map();
    
                    // First, categorize all loras
                    remainingLoras.forEach(lora => {
                        if (!this.showNSFW && this.isNSFW(lora)) return;
    
                        let category = 'Unsorted';
                        if (this.sortModels === 'Tags') {
                            const activeTags = this.getActiveTags();
                            if (lora.tags) {
                                const matchingTag = activeTags.find(tag => lora.tags.includes(tag));
                                if (matchingTag) category = matchingTag;
                            }
                        } else if (this.sortModels === 'Subdir') {
                            category = lora.subdir ? lora.subdir.split('\\').pop() : 'Unsorted';
                        }
    
                        if (!categorizedLoras.has(category)) {
                            categorizedLoras.set(category, []);
                        }
                        categorizedLoras.get(category).push(lora);
                    });

                    categorizedLoras = new Map(
                        Array.from(categorizedLoras.entries())
                            .sort((a, b) => {
                                if (a[0] === 'Unsorted') return 1;
                                if (b[0] === 'Unsorted') return -1;
                                return a[0].localeCompare(b[0]);
                            })
                    );
    
                    // First pass - create all categories with 1 item each
                    for (const [category, loras] of categorizedLoras) {

                        debug.log("Initial category load for", category, ":", {
                            totalLoras: loras.length,
                            firstItem: loras[0],
                            pendingCount: loras.length > 1 ? loras.slice(1).length : 0
                        });

                        this.searchCount = totalLoras;
                        const initialItems = loras.slice(0, 1);
                        const categoryElement = this.createCategoryElement(category, initialItems);
                        if (categoryElement) {
                            this.galleryContainer.appendChild(categoryElement);
                            remainingItems--;

                            // Store pending items
                            const lorasContainer = categoryElement.querySelector('.lora-items-container');
                            if (lorasContainer && loras.length > 1) {
                                lorasContainer.dataset.pendingLorasData = JSON.stringify(loras.slice(1));
                                lorasContainer.dataset.totalItems = loras.length;
                            }

                            // Update the count display
                            const countDisplay = categoryElement.querySelector('.category-count');
                            if (countDisplay) {
                                // Use "broken" count display for special categories TODO - THIS IS RIDICULOUS
                                if (category === "Favorites") {
                                    const favoritesCategory = this.galleryContainer.querySelector(
                                        '.lora-category[data-category="Favorites"]'
                                    );
                                    const favContainer = favoritesCategory.querySelector('.lora-items-container');
                                    const totalFavorites = favContainer ? favContainer.children.length : loras.length;
                                    countDisplay.textContent = `totalBULLSHIT/${loras.length}`;
                                } else {
                                const totalFromInfo = this.categoryInfo?.[category]?.total;
                                countDisplay.textContent = `${loras.length}/${totalFromInfo}`;
                                }
                            }
                        }
                    }

                    // Second pass - distribute remaining budget to expanded categories
                    if (remainingItems > 0) {
                        for (const [category, loras] of categorizedLoras) {
                            debug.log(`Processing category: ${category}`);
                            const categoryElement = this.galleryContainer.querySelector(
                                `.lora-category[data-category="${category}"]`
                            );
                            if (!categoryElement) continue;

                            const container = categoryElement.querySelector('.lora-items-container');
                            if (!container || window.getComputedStyle(container).display === 'none') {
                                debug.log(`Skipping ${category}, container:${!!container}, display:${container ? window.getComputedStyle(container).display : 'no-container'}`);
                                continue;
                            }

                            // Load up to remaining budget
                            const pendingItems = JSON.parse(container.dataset.pendingLorasData || '[]');
                            const itemsToLoad = pendingItems.slice(0, remainingItems);
                            if (itemsToLoad.length > 0) {
                                this.createLoraElementsForCategory(container, itemsToLoad);
                                remainingItems -= itemsToLoad.length;
                                
                                // Update pending data
                                const newPending = pendingItems.slice(itemsToLoad.length);
                                if (newPending.length > 0) {
                                    container.dataset.pendingLorasData = JSON.stringify(newPending);
                                } else {
                                    delete container.dataset.pendingLorasData;
                                }

                                // Update the count display
                                const countDisplay = categoryElement.querySelector('.category-count');
                                if (countDisplay) {
                                    const total = parseInt(container.dataset.totalItems || 0);
                                    countDisplay.textContent = `${container.children.length}/${total}`;
                                }


                            }

                            if (remainingItems <= 0) break;
                        }
                    }
                }
    
                this.sortCategories();
                this.updateGalleryLayout();
                this.initialRenderComplete = true;
    
            } else {
                // Handle subsequent batch loads (scrolling)
                const lorasToRender = this.filteredData.slice(startIndex, startIndex + count);
                lorasToRender.forEach(lora => {
                    if (!lora.favorite && (!lora.is_new || !this.CatNew)) {
                        const categoryName = this.getCategoryForLora(lora);
                        const categoryElement = this.galleryContainer.querySelector(
                            `.lora-category[data-category="${categoryName}"]`
                        );
                        if (categoryElement) {
                            const lorasContainer = categoryElement.querySelector('.lora-items-container');
                            const isExpanded = window.getComputedStyle(lorasContainer).display !== 'none';
                            if (isExpanded) {
                                this.createLoraElementsForCategory(lorasContainer, [lora]);
                            }
                        }
                    }
                });
            }
    
        } catch (error) {
            console.error('Critical error in renderLoraGallery:', error);
        }
    }

    sortCategories() {
        const categories = Array.from(this.galleryContainer.querySelectorAll('.lora-category'));
        categories.sort((a, b) => {
            // Get category names
            const aName = a.getAttribute('data-category');
            const bName = b.getAttribute('data-category');
    
            // Special handling for fixed-position categories
            if (aName === 'Favorites') return -1;  // Favorites always first
            if (bName === 'Favorites') return 1;
            if (aName === 'New') return -1;        // New always second
            if (bName === 'New') return 1;
    
            // All other categories sort alphabetically
            return aName.localeCompare(bName);
        });
    
        // Reappend in sorted order
        categories.forEach(category => this.galleryContainer.appendChild(category));
    }

    getCategoryItems(categoryName) {
        const activeTags = this.getActiveTags();
        let items;
        const NEW_CATEGORY_LIMIT = 100;
    
        if (categoryName === "Favorites") {
            items = this.filteredData.filter(lora => lora.favorite);
        } else if (categoryName === "New") {
            // Only process if the setting is enabled
            if (!this.CatNew) {
                return [];
            }
    
            // Get new items excluding favorites
            let newItems = this.filteredData.filter(lora => lora.is_new && !lora.favorite);
    
            // If we have more than limit items, check if they all have the same date
            if (newItems.length > NEW_CATEGORY_LIMIT) {
                // Get unique creation times
                const uniqueDates = new Set(newItems.map(lora => lora.created_time));
                
                // If all items have the same date (likely initial import)
                // and we're over the limit, disable the category
                if (uniqueDates.size === 1) {
                    return [];
                }
    
                // Otherwise, just limit to the most recent items
                newItems = newItems.slice(0, NEW_CATEGORY_LIMIT);
            }
    
            items = newItems;
        } else if (this.sortModels === 'Subdir') {
            items = this.filteredData.filter(lora => {
                const parts = lora.subdir ? lora.subdir.split('\\') : [];
                return parts[parts.length - 1] === categoryName;
            });
        } else if (this.sortModels === 'Tags') {
            if (activeTags.includes(categoryName)) {
                items = this.filteredData.filter(lora => 
                    lora.tags && lora.tags.includes(categoryName)
                );
            } else if (categoryName === 'Unsorted') {
                items = this.filteredData.filter(lora => 
                    !lora.tags || !activeTags.some(tag => lora.tags.includes(tag))
                );
            }
        }
    
        return items || [];
    }
    

    setupScrollHandler() {
        debug.log("Setting up scroll handler");
       
        const observer = new MutationObserver(() => {
            const sidebarContentContainer = document.querySelector('.sidebar-content-container');
                   
            if (sidebarContentContainer) {
                debug.log("Sidebar content container found, attaching scroll handler");
       
                let isLoading = false; // Track actual load state
                let scrollTimeout;
                   
                sidebarContentContainer.addEventListener('scroll', async () => {
                    // Clear any existing timeout
                    if (scrollTimeout) {
                        clearTimeout(scrollTimeout);
                    }

                    // Set a new timeout to save scroll position after scrolling stops
                    scrollTimeout = setTimeout(() => {
                        this.saveScrollPosition();
                    }, 100);

                    // Regular processing for normal category modes
                    if (this.sortModels !== 'None') {
                        if (!isLoading) {
                            isLoading = true;
                            this.handleScrollStart();
                            isLoading = false;
                        }
                        return;
                    }
    
                    // Special case for "All LoRAs" mode - only near bottom
                    if (!isLoading && this.isNearBottom(sidebarContentContainer)) {
                        const currentItemCount = this.galleryContainer.querySelectorAll('.lora-item').length;
                        
                        // Skip if we're trying to load the same offset
                        if (currentItemCount === this.lastOffset) {
                            debug.log("Skipping duplicate load at offset:", this.lastOffset);
                            return;
                        }

                        debug.log("Near bottom in All LoRAs mode - starting load at offset:", currentItemCount);
                        this.lastOffset = currentItemCount;
                        isLoading = true;
                        this.handleScrollStart();
                        isLoading = false;
                    }
                }, { passive: true });

                // Restore scroll position after content is loaded
                if (this.state.scrollPosition) {
                    const restoreScroll = () => {
                        sidebarContentContainer.scrollTop = this.state.scrollPosition;
                    };
                    
                    // Try immediately and after a short delay to ensure content is loaded
                    restoreScroll();
                    setTimeout(restoreScroll, 100);
                }
       
                observer.disconnect();
            }
        });
       
        observer.observe(document.body, { childList: true, subtree: true });
    }

    async loadCategoryBatch(categoryName, loadedCount, isFromMinimize = false) {
        if (this.isLoading) return;
        this.isLoading = true;
    
        try {
            const response = await api.fetchApi(
                `/lora_sidebar/category/${encodeURIComponent(categoryName)}`
            );
            
            if (response.ok) {
                const data = await response.json();
                if (data.category_ids?.length) {

                    debug.log("Loading category", categoryName, ":", {
                        totalIds: data.category_ids.length,
                        firstId: data.category_ids[0],
                        loadedCount
                    });

                    const category = this.galleryContainer.querySelector(
                        `.lora-category[data-category="${categoryName}"]`
                    );
                    if (category) {
                        const container = category.querySelector('.lora-items-container');
                        if (container) {
                            // If this is from minimize and we're already at 250, skip loading more
                            if (isFromMinimize && container.children.length >= 250) { //TODO - can't assume this is enough for everyone
                                return;
                            }

                            // Get currently loaded ids from container
                            const existingIds = Array.from(container.children)
                            .map(child => {
                                const img = child.querySelector('img');
                                if (!img) return null;
                                const src = img.src;
                                const encodedFilename = src.split('/').pop();
                                const filename = decodeURIComponent(encodedFilename);
                        
                                // Only compare against the IDs in this category
                                return data.category_ids.find(id => 
                                    filename === id || 
                                    encodedFilename === id
                                );
                            })
                            .filter(Boolean);

                            debug.log("Category IDs:", data.category_ids);
                            debug.log("Found existing IDs:", existingIds);

                            // Filter out already loaded ids from the full set
                            const validIds = data.category_ids.filter(id => 
                                !existingIds.includes(id)
                                // && this.filteredData.some(lora => lora.id === id) - can remove?
                            );

                            /*
                             // respect search
                            const ids = this.currentSearchInput.length > 0
                            ? data.category_ids.filter(id => 
                                this.filteredData.some(lora => lora.id === id))
                            : data.category_ids; */

                            // Special case: If all ids are "valid" but we know we have one loaded,
                            // we need to slice off the first one to avoid duplication
                            // If the first ID from category_ids is in our valid list, remove it
                            if (validIds.includes(data.category_ids[0])) {
                                const firstIdIndex = validIds.indexOf(data.category_ids[0]);
                                validIds.splice(firstIdIndex, 1);
                            }
                            
                            // const remainingIds = (validIds.length === data.category_ids.length && loadedCount === 1) 
                            //? validIds.slice(loadedCount) 
                            //: validIds;
                            const remainingIds = validIds
                            debug.log("Category:", category, "Remaining IDs:", remainingIds);

                            // If from minimize, limit how many we load
                            const idsToLoad = isFromMinimize 
                            ? remainingIds.slice(0, 250 - container.children.length)
                            : remainingIds;

                            const remainingLoras = idsToLoad
                                .map(id => this.filteredData.find(lora => lora.id === id))
                                .filter(Boolean)
                                .filter(lora => this.showNSFW || !this.isNSFW(lora));
    
                            this.createLoraElementsForCategory(container, remainingLoras);

                            // Update count
                            const countDisplay = category.querySelector('.category-count');
                            if (countDisplay) {
                                const total = countDisplay.textContent.split('/')[1]; // Get the current 'total' part
                                countDisplay.textContent = `${container.children.length}/${total}`;
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.error(`Error loading batch for category ${categoryName}:`, error);
        } finally {
            this.isLoading = false;
        }
    }
    
    handleScrollStart() {   
        if (this.isLoading) return;
    
        const sidebarContentContainer = document.querySelector('.sidebar-content-container');
        
        if (this.currentSearchInput.length > 0) {
            debug.log("Scrolling during search:", this.currentSearchInput);
        }
        
        // Do the initial calculations
        const containerRect = sidebarContentContainer.getBoundingClientRect();
        const buffer = containerRect.height * 0.5;
        
        // Find categories that need processing
        const categories = Array.from(this.galleryContainer.querySelectorAll('.lora-category'));
        
        // Keep your debug logging
        categories.forEach(category => {
            const container = category.querySelector('.lora-items-container');
            if (container && window.getComputedStyle(container).display !== 'none') {
                const categoryName = category.getAttribute('data-category');
                debug.log(`Category ${categoryName}:`, {
                    loadedItems: container.children.length,
                    totalItems: parseInt(container.dataset.totalItems || 0),
                    pendingData: container.dataset.pendingLorasData ? 
                        JSON.parse(container.dataset.pendingLorasData).length : 0,
                    filtered: this.currentSearchInput.length > 0 ? 
                        this.filteredData.filter(l => this.getCategoryForLora(l) === categoryName).length : 'n/a'
                });
            }
        });
    
        const approachingCategories = categories.filter(category => {
            // Skip "All LoRAs" category when using None sorting
            if (this.sortModels === 'None' && category.getAttribute('data-category') === "All LoRAs") {
                return false;
            }

            const container = category.querySelector('.lora-items-container');
            if (!container || window.getComputedStyle(container).display === 'none') {
                return false;
            }
            
            const rect = category.getBoundingClientRect();
            const currentCount = container.children.length;
            const totalItems = parseInt(container.dataset.totalItems || 0);

            const needsLoading = (currentCount < 500 && (container.dataset.pendingLorasData || 
                currentCount < totalItems)) || 
                (currentCount >= 500 && totalItems > currentCount && 
                this.isNearCategoryEnd(category));
            
            return needsLoading && 
                   rect.top <= containerRect.bottom + buffer && 
                   rect.bottom >= containerRect.top - buffer;
        });
    
        if (approachingCategories.length > 0) {
            // Process categories in chunks
            this.processCategories(approachingCategories, 0, 100); // Process 100 items at a time
        }
    
        // Handle non-categorized view
        if (this.sortModels === 'None' && this.isNearBottom(sidebarContentContainer)) {
            let currentItemCount = this.galleryContainer.querySelectorAll('.lora-item').length;
            const allLorasCategory = this.galleryContainer.querySelector('.lora-category[data-category="All LoRAs"]');

            // Check for minimized favorites and adjust count using actual favorites data
            const favoriteCount = this.filteredData.filter(lora => lora.favorite).length;
            const favoritesCategory = this.galleryContainer.querySelector('.lora-category[data-category="Favorites"]');
            const favoritesMinimized = favoritesCategory && 
                window.getComputedStyle(favoritesCategory.querySelector('.lora-items-container')).display === 'none';

            // Use filteredData.length as total during search
            let effectiveTotal = this.currentSearchInput.length > 0 ? this.filteredData.length : this.totalCount;

            if (favoritesMinimized) {
                effectiveTotal -= favoriteCount;
            }
            
            debug.log("All LoRAs scroll check:", {
                currentItemCount,
                effectiveTotal,
                totalCount: this.totalCount,
                isFiltered: this.currentSearchInput.length > 0,
                isProcessing: this.isLoading
            });
        
            if (currentItemCount < effectiveTotal && !this.isLoading) {
                this.isLoading = true;
                if (this.currentSearchInput.length > 0) {
                    const nextBatch = this.filteredData.slice(
                        currentItemCount,
                        currentItemCount + Math.min(100, this.batchSize)
                    );
                    if (nextBatch.length) {
                        this.createLoraElementsForCategory(this.galleryContainer, nextBatch);
                    }
                } else {
                    this.loadLoraData(currentItemCount, Math.min(100, this.batchSize));
                }
                this.isLoading = false;
            }
        }
    }

    // process categories in chunks
    processCategories(categories, startIndex, chunkSize) {
        if (startIndex >= categories.length) return;
        
        const category = categories[startIndex];
        const container = category.querySelector('.lora-items-container');
        const categoryName = category.getAttribute('data-category');
        
        let itemsProcessed = 0;
        const pendingItems = container.dataset.pendingLorasData ? 
            JSON.parse(container.dataset.pendingLorasData) : [];
        
        if (pendingItems.length > 0) {
            const itemsToLoad = pendingItems.slice(0, chunkSize);
            this.createLoraElementsForCategory(container, itemsToLoad);
            
            if (itemsToLoad.length < pendingItems.length) {
                const remainingItems = pendingItems.slice(itemsToLoad.length);
                container.dataset.pendingLorasData = JSON.stringify(remainingItems);
            } else {
                delete container.dataset.pendingLorasData;
            }

            // Update count display
            const countDisplay = category.querySelector('.category-count');
            if (countDisplay) {
                const total = countDisplay.textContent.split('/')[1];
                countDisplay.textContent = `${container.children.length}/${total}`;
            }
            
            itemsProcessed = itemsToLoad.length;
        }

        // Process next chunk after a small delay
        if (startIndex + 1 < categories.length || itemsProcessed >= chunkSize) {
            setTimeout(() => {
                this.processCategories(categories, startIndex + 1, chunkSize);
            }, 16);
        }
    }

    isNearCategoryEnd(category) {
        const container = category.querySelector('.lora-items-container');
        if (!container) return false;
    
        const lastItem = container.lastElementChild;
        if (!lastItem) return false;
    
        const viewportHeight = window.innerHeight;
        const lastItemRect = lastItem.getBoundingClientRect();
        
        // Check if last item is visible in viewport with a small buffer
        const buffer = 200; // pixels
        return lastItemRect.top <= viewportHeight + buffer && lastItemRect.bottom >= -buffer;
    }
    
    isNearBottom(container) {
        const scrollPosition = container.scrollTop + container.clientHeight;
        const totalHeight = container.scrollHeight;
        const scrollThreshold = 0.9; // 90% of the way down
        return scrollPosition / totalHeight > scrollThreshold;
    }
    
    createCategoryElement(categoryName, loras, appendToExisting = false) {
        let categoryContainer;
        
        if (appendToExisting) {
            categoryContainer = this.galleryContainer.querySelector(`.lora-category[data-category="${categoryName}"]`);
            
            if (!categoryContainer) {
                categoryContainer = $el("div.lora-category", {
                    draggable: false
                });
                categoryContainer.setAttribute('data-category', categoryName);
            }
        } else {
            categoryContainer = $el("div.lora-category", {
                draggable: false
            });
            categoryContainer.setAttribute('data-category', categoryName);
        }
    
        let header = categoryContainer.querySelector('.category-header');
        if (!header) {
            // Get expanded state based on if it's Favorites
            const isExpanded = categoryName === "Favorites" && this.FavOpen ? true :
                this.state.categoryStates[categoryName] !== undefined ? 
                this.state.categoryStates[categoryName] : 
                this.defaultCatState;
            
            // Get counts from category info
            let totalCount = this.categoryInfo?.[categoryName]?.total || loras.length;
            let loadedCount = loras.length;

            // Add debug logs to see what we're getting
            debug.log(`Creating category ${categoryName}:`, {
                categoryInfo: this.categoryInfo?.[categoryName],
                lorasLength: loras.length,
                totalFromInfo: this.categoryInfo?.[categoryName]?.total,
                totalCount: totalCount,
            });
            
            header = $el("div.category-header", {
                draggable: false
            }, [
                $el("h3.category-title", {}, [categoryName]),
                $el("span.category-count", {}, [
                    this.currentSearchInput.length && !isExpanded ?
                        `${loras.length}/${totalCount}` :
                        `${loras.length}/${totalCount}`
                ]),
                $el("span.category-toggle", {}, [isExpanded ? "▼" : "▶"])
            ]);
            
            header.addEventListener('click', () => this.toggleCategory(categoryName));
            categoryContainer.appendChild(header);
        }
    
        let lorasContainer = categoryContainer.querySelector('.lora-items-container');
        if (!lorasContainer) {
            lorasContainer = $el("div.lora-items-container", {
                draggable: false
            });
    
            const isExpanded = categoryName === "Favorites" && this.FavOpen ? true : 
                this.state.categoryStates[categoryName] !== undefined ? 
                this.state.categoryStates[categoryName] : 
                this.defaultCatState;
            
            lorasContainer.style.display = isExpanded ? 'grid' : 'none';
            
            // Store category info
            lorasContainer.dataset.totalItems = this.categoryInfo?.[categoryName]?.total || loras.length;
            
            // Only create lora elements if expanded, otherwise store for later
            if (!isExpanded) {
                // Special case: Always create the first item
                if (loras.length === 1) {
                    this.createLoraElementsForCategory(lorasContainer, loras);
                }
                lorasContainer.dataset.pendingLoras = JSON.stringify(loras.map(lora => lora.id));
                lorasContainer.dataset.pendingLorasData = JSON.stringify(loras);
            } else {
                this.createLoraElementsForCategory(lorasContainer, loras);
            }
            
            categoryContainer.appendChild(lorasContainer);
        } else if (appendToExisting) {
            const isExpanded = window.getComputedStyle(lorasContainer).display !== 'none';
            if (isExpanded) {
                this.createLoraElementsForCategory(lorasContainer, loras);
                // Update loaded count
                lorasContainer.dataset.loadedItems = 
                    parseInt(lorasContainer.dataset.loadedItems || 0) + loras.length;
            } else {
                // Update pending loras data
                const pendingLoras = JSON.parse(lorasContainer.dataset.pendingLoras || '[]');
                const pendingLorasData = JSON.parse(lorasContainer.dataset.pendingLorasData || '[]');
                
                pendingLoras.push(...loras.map(lora => lora.id));
                pendingLorasData.push(...loras);
                
                lorasContainer.dataset.pendingLoras = JSON.stringify(pendingLoras);
                lorasContainer.dataset.pendingLorasData = JSON.stringify(pendingLorasData);
            }
        }
    
        return categoryContainer;
    }

    createLoraElementsForCategory(container, loras) {
        //loras.forEach(lora => {
        //    const loraElement = this.createLoraElement(lora);
/*        const categoryElement = container.closest('.lora-category');
          const categoryName = categoryElement?.getAttribute('data-category');
          const catName = "jarfu"
        
        if (categoryName === catName) {
            debug.log("Creating lora elements for test category:", 
                loras.map(l => ({
                    id: l.id,
                    name: l.name,
                    favorite: l.favorite,
                    is_new: l.is_new,
                    caller: new Error().stack  // This will show us where this was called from
                }))
            );
        } */

        // Get existing IDs from the data attributes on the lora-items
        const existingIds = Array.from(container.querySelectorAll('.lora-item'))
            .map(item => item.querySelector('[draggable="true"]')?.dataset?.loraId)
            .filter(Boolean);
        
        loras.forEach(lora => {
            if (existingIds.includes(lora.id)) return;

            const loraElement = this.createLoraElement(lora);
/*             if (loraElement && categoryName === catName) {
                debug.log("Created individual lora element:", {
                    id: lora.id,
                    name: lora.name,
                    favorite: lora.favorite,
                    is_new: lora.is_new,
                    category: lora.category,
                    caller: new Error().stack
                });
            } */
            
            if (loraElement) {
                container.appendChild(loraElement);
            }
        });
        this.updateGalleryLayout();
    }
    
    async toggleCategory(categoryName) {

        // hack for a hack of a hack, TODO CLEAN THIS UP OMG
        if (this.currentSearchInput.length) {
            const category = this.galleryContainer.querySelector(
                `.lora-category[data-category="${categoryName}"]`
            );
            if (category) {
                const container = category.querySelector('.lora-items-container');
                if (container) {
                    const categoryLoras = this.filteredData.filter(lora => 
                        !lora.favorite && 
                        (!lora.is_new || !this.CatNew) && 
                        this.getCategoryForLora(lora) === categoryName
                    );
                    
                    // If we have exactly 1 filtered result and pending data, clear pending
                    if (categoryLoras.length === 1 && container.dataset.pendingLorasData) {
                        delete container.dataset.pendingLorasData;
                        delete container.dataset.pendingLoras;
                    }
                }
            }
        }

        const category = this.galleryContainer.querySelector(
            `.lora-category[data-category="${categoryName}"]`
        );
        if (!category) return;
    
        const content = category.querySelector('.lora-items-container');
        const toggle = category.querySelector('.category-toggle');
        
        if (!content || !toggle) return;
    
        const isVisible = window.getComputedStyle(content).display !== 'none';

        // Track if Favorites was manually closed
        if (categoryName === "Favorites") {
            this.FavOpen = !isVisible;
        }
        
        if (isVisible) {
            content.style.display = 'none';
            toggle.textContent = '▶';
            this.state.categoryStates[categoryName] = false;

            // Skip preload logic if this is the "All LoRAs" category
            if (categoryName === "All LoRAs") return;
        
            // When minimizing, check next categories
            const categories = Array.from(this.galleryContainer.querySelectorAll('.lora-category'));
            const currentIndex = categories.findIndex(cat => cat === category);
            let remainingBudget = 250; // Load up to 250 items
            let checkedCount = 0;
        
            // Start from next category
            for (let i = currentIndex + 1; i < categories.length && checkedCount < 3; i++) {
                const nextCat = categories[i];
                const nextContainer = nextCat.querySelector('.lora-items-container');
        
                // Check if this category is already well-loaded
                if (nextContainer && nextContainer.children.length >= 200) {
                    break; // Stop loading if we hit a category with plenty of items
                }
                
                // Only process if category is expanded and has pending items
                if (nextContainer && 
                    window.getComputedStyle(nextContainer).display !== 'none' && 
                    nextContainer.dataset.pendingLorasData) {
                    
                    checkedCount++;
                    const nextCategoryName = nextCat.getAttribute('data-category');
                    const loadedCount = nextContainer.children.length;
                    const pendingItems = JSON.parse(nextContainer.dataset.pendingLorasData);
                    
                    // Calculate how many items we can load with remaining budget
                    const itemsToLoad = Math.min(remainingBudget, pendingItems.length);
                    
                    if (itemsToLoad > 0) {
                        await this.loadCategoryBatch(nextCategoryName, loadedCount, true);
                        
                        // Update pending data
                        const newLoadedCount = nextContainer.children.length;
                        const itemsLoaded = newLoadedCount - loadedCount;
                        
                        if (itemsLoaded > 0) {
                            // Update pending data to remove loaded items
                            const remainingPendingItems = pendingItems.slice(itemsLoaded);
                            if (remainingPendingItems.length > 0) {
                                nextContainer.dataset.pendingLorasData = JSON.stringify(remainingPendingItems);
                            } else {
                                delete nextContainer.dataset.pendingLorasData;
                            }
                            
                            remainingBudget -= itemsLoaded;
                            if (remainingBudget <= 0) break;
                        }
                    }
                }
            }
        } else {
            content.style.display = 'grid';
            toggle.textContent = '▼';
            this.state.categoryStates[categoryName] = true;
        
            if (content.dataset.pendingLorasData) {
                const pendingItems = JSON.parse(content.dataset.pendingLorasData);
                const loadedCount = content.children.length;
                const toLoad = pendingItems.slice(0, Math.max(0, 500 - loadedCount));
                this.createLoraElementsForCategory(content, toLoad);
                
                // Update pending data if there are more items
                const remainingItems = pendingItems.slice(Math.max(0, 500 - loadedCount));
                if (remainingItems.length > 0) {
                    content.dataset.pendingLorasData = JSON.stringify(remainingItems);
                } else {
                    delete content.dataset.pendingLorasData;
                }
            } else if (categoryName === "All LoRAs") {
                const currentCount = content.children.length;
                const remainingLoras = this.filteredData.filter(lora => 
                    !lora.favorite && (!lora.is_new || !this.CatNew)
                );
        
                // Only load up to 500 items initially
                const initialLoadCount = Math.min(500 - currentCount, remainingLoras.length - currentCount);
                if (initialLoadCount > 0) {
                    const lorasToAdd = remainingLoras.slice(currentCount, currentCount + initialLoadCount);
                    this.createLoraElementsForCategory(content, lorasToAdd);
                }
        
                // Store remaining items as pending if there are more
                if (remainingLoras.length > content.children.length) {
                    content.dataset.pendingLorasData = JSON.stringify(
                        remainingLoras.slice(content.children.length)
                    );
                }
            }
        
            const loadedCount = content.children.length;
            debug.log("Toggle expand - current children count:", loadedCount);
            debug.log("Current children:", content.children);
            const totalCount = this.categoryInfo?.[categoryName]?.total || loras.length;
            content.dataset.totalItems = totalCount.toString();
            
            if (loadedCount < 500 && loadedCount < totalCount) {
                await this.loadCategoryBatch(categoryName, loadedCount);
            }

            // We need to update the count display here after loading items
            const countDisplay = category.querySelector('.category-count');
            if (countDisplay) {
                countDisplay.textContent = `${content.children.length}/${totalCount}`;
            }
        }
    
        this.saveState();
        this.updateGalleryLayout();
    }

    getFontSizeBasedOnLength(text) {
        const length = text.length;
        if (length <= 10) {
            return "16px"; // Largest font size for short text
        } else if (length <= 20) {
            return "14px";
        } else if (length <= 30) {
            return "12px";
        } else {
            return "10px"; // Minimum font size with ellipsis
        }
    }

    createLoraElement(lora, forceRefresh = false) {
        try {
                const container = $el("div.lora-item");
                const previewUrl = forceRefresh
                ? `/lora_sidebar/preview/${encodeURIComponent(lora.id)}?cb=${Date.now()}`
                : `/lora_sidebar/preview/${encodeURIComponent(lora.id)}`;
                
                let isVideo = false;
                let previewElement;
                
                const createPreviewElement = (tryVideo = false) => {
                    isVideo = tryVideo;
                    const elementType = isVideo ? "video" : "img";
                    const element = $el(elementType, {
                        src: previewUrl,
                        alt: lora.name,
                        draggable: true,
                        ...(isVideo && { loop: true, muted: true }),
                        ondragstart: (e) => {
                            const dragData = JSON.stringify({
                                type: "comfy-lora",
                                id: lora.id
                            });
                            e.dataTransfer.setData("application/json", dragData);
                            this.handleDragStart(e);
                        },
                        onerror: (e) => {
                            if (!e.target.hasAttribute('data-error-handled')) {
                                e.target.setAttribute('data-error-handled', 'true');
                                if (!isVideo) {
                                    const videoElement = createPreviewElement(true);
                                    container.replaceChild(videoElement, previewElement);
                                    previewElement = videoElement;
                                } else {
                                    debug.log(`Using placeholder for ${lora.name}`);
                                    const imgElement = $el("img", {
                                        src: this.placeholderUrl,
                                        alt: lora.name,
                                        draggable: true
                                    });
                                    container.replaceChild(imgElement, previewElement);
                                    previewElement = imgElement;
                                    isVideo = false;
                                }
                            }
                        },
                        onloadedmetadata: isVideo ? (e) => {
                            if (e.target.videoWidth === 0 && e.target.videoHeight === 0) {
                                debug.log(`Invalid video for ${lora.name}, using placeholder`);
                                const imgElement = $el("img", {
                                    src: this.placeholderUrl,
                                    alt: lora.name,
                                    draggable: true
                                });
                                container.replaceChild(imgElement, previewElement);
                                previewElement = imgElement;
                                isVideo = false;
                            }
                        } : null
                    });
                    return element;
                };
            
                previewElement = createPreviewElement();
            
                const overlay = $el("div.lora-overlay", {
                    draggable: true,
                    ondragstart: (e) => {
                        e.stopPropagation();
                        const dragData = JSON.stringify({
                            type: "comfy-lora",
                            id: lora.id
                        });

                        
                        // Debug logs for element finding
                        const loraItem = e.target.parentElement;
                        debug.log("LoRA Item found:", loraItem);

                        const img = loraItem.querySelector('img');
                        debug.log("Image element found:", img);

                        if (img) {
                            debug.log("Attempting to set drag image:", {
                                width: img.width,
                                height: img.height,
                                src: img.src,
                                complete: img.complete
                            });
                            e.dataTransfer.setDragImage(img, img.width / 2, img.height / 2);
                        } else {
                            console.error("No image element found in LoRA item");
                        }


                        debug.log("Setting drag data from overlay:", dragData);
                        e.dataTransfer.setData("application/json", dragData);
                        this.handleDragStart(e);
                    }
                });
            
                const buttonContainer = $el("div.lora-buttons", [
                    this.createButton("📋", "Copy", () => this.copyTrainedWords(lora)),
                    this.createButton("🔄", "Refresh", () => this.refreshLora(lora)),
                    this.createButton(lora.favorite ? "★" : "☆", "Favorite", () => this.toggleFavorite(lora)),
                    this.createButton("ℹ️", "Info", (e) => this.showLoraInfo(lora, e.target)),
                ]);
            
                const fontSize = this.getFontSizeBasedOnLength(lora.name);
            
                const titleContainer = $el("div.lora-title", [
                    $el("h4", { 
                        textContent: lora.name,
                        style: { fontSize: fontSize }
                    })
                ]);
            
                overlay.appendChild(buttonContainer);
                overlay.appendChild(titleContainer);

                if (this.isNSFW(lora) && this.nsfwThreshold < 50) {
                    container.classList.add('nsfw');
                    const nsfwLabel = $el("span.nsfw-label", {
                        textContent: lora.nsfw ? "NSFW" : `NSFW Level: ${lora.nsfwLevel}`
                    });
                    container.appendChild(nsfwLabel);
                }
            
                // Add hover events to the overlay for video control
                overlay.addEventListener('mouseenter', () => {
                    if (isVideo && previewElement instanceof HTMLVideoElement) {
                        previewElement.play().then(() => {
                        }).catch(error => {
                            console.error(`Error playing video for ${lora.name}:`, error);
                        });
                    }
                });
                
                overlay.addEventListener('mouseleave', () => {
                    if (isVideo && previewElement instanceof HTMLVideoElement) {
                        previewElement.pause();
                        previewElement.currentTime = 0;
                    }
                });
            
                container.appendChild(previewElement);
                container.appendChild(overlay);
            
                return container;
            } catch (error) {
                console.error('Failed to create LoRA element:', lora?.name || 'unknown', error);
                return null;
            }
    }
    
    createButton(icon, tooltip, onClick) {
        return $el("button", {
            textContent: icon,
            title: tooltip,
            onclick: onClick
        });
    }

    showToast(severity, summary, detail, life = 3000) {
        this.app.extensionManager.toast.add({ severity, summary, detail, life });
    }

    copyTrainedWords(lora) {
        if (lora.trained_words && lora.trained_words.length > 0) {
            const trainedWordsText = lora.trained_words.join(', ');
            navigator.clipboard.writeText(trainedWordsText).then(() => {
                this.showToast("success", "Copied", "Trained words copied to clipboard.");
            }).catch(err => {
                console.error('Failed to copy trained words:', err);
                this.showToast("error", "Copy Failed", "Failed to copy trained words to clipboard.");
            });
        } else {
            this.showToast("info", "No Trained Words", "No trained words exist for this LoRA.");
        }
    }

    async refreshLora(lora) {
        if (!lora || !lora.id) {
            console.error("Invalid LoRA object or missing ID:", lora);
            app.extensionManager.toast.add({
                severity: "error",
                summary: "Refresh Failed",
                detail: "Invalid LoRA data. Please try reloading the page.",
                life: 5000
            });
            return;
        }
    
        try {
            // First, call /refresh/{lora_id} to get versionId if it doesn't exist
            let versionId = lora.versionId;
            if (!versionId) {
                debug.log(`No versionId for LoRA ${lora.name}, performing hash lookup.`);
                const idResponse = await api.fetchApi(`/lora_sidebar/refresh/${lora.id}`, {
                    method: 'POST'
                });
    
                if (!idResponse.ok) {
                    // Check local_metadata flag to determine if this is a custom LoRA
                    if (lora.local_metadata) {
                        this.showToast("warn", "Custom LoRA Detected", 'Skipping refresh for custom LoRA, please use the LoRA Info Pop-up window to update metadata and images for Custom LoRAs.', 5000);
                        return; // Exit early for custom LoRA
                    } else {
                        throw new Error(`Failed to perform hash lookup for LoRA: ${lora.name}, model probably removed.`);
                    }
                }
    
                const idResult = await idResponse.json();
                if (idResult.status === 'success' && idResult.data && idResult.data.versionId) {
                    versionId = idResult.data.versionId;
                    debug.log(`Found versionId ${versionId} for LoRA ${lora.name}`);
                } else {
                    throw new Error(`Missing or malformed data in API response for LoRA: ${lora.name}`);
                }
            }
    
            // Now that we have the versionId, proceed to refresh with /refresh/{version_id}
            debug.log(`Refreshing LoRA with version ID: ${versionId}`);
            debug.log("Looking for LoRA:", {
                searchVersionId: versionId,
                searchId: lora.id,
                matchingLoras: this.loraData.filter(l => 
                    l.versionId === versionId || l.id === lora.id
                ).map(l => ({
                    id: l.id,
                    versionId: l.versionId,
                    name: l.names
                })),
                // Add this to see what we actually have
                allLoras: this.loraData.map(l => ({
                    id: l.id, 
                    versionId: l.versionId,
                    name: l.name
                }))
            });
            const response = await api.fetchApi(`/lora_sidebar/refresh/${versionId}`, {
                method: 'POST'
            });
    
            if (!response.ok) {
                throw new Error(`Server responded with ${response.status}: ${response.statusText}`);
            }
    
            const result = await response.json();
            debug.log("Refresh Result:", result);
    
            if (result.status === 'success') {
                if (result.data) {
                    debug.log("Updated LoRA Data:", result.data);
                    const updatedLoraData = result.data;
                    const index = this.loraData.findIndex(l => l.versionId === versionId || l.id === lora.id);
                    if (index !== -1) {
                        // Merge existing LoRA with updated data to preserve 'id'
                        this.loraData[index] = { ...this.loraData[index], ...updatedLoraData };
                        debug.log("Merged LoRA Data:", this.loraData[index]);
                        this.filteredData = [...this.loraData];
                        // check for categoryInfo
                        if (result.categoryInfo) {
                            this.categoryInfo = result.categoryInfo;
                        }
                        this.handleSearch(this.state.searchTerm || '');
                        app.extensionManager.toast.add({
                            severity: "success",
                            summary: "LoRA Refreshed",
                            detail: `${updatedLoraData.name} has been successfully refreshed.`,
                            life: 3000
                        });
                    } else {
                        throw new Error("LoRA not found in local data");
                    }
                } else {
                    app.extensionManager.toast.add({
                        severity: "info",
                        summary: "No Update Needed",
                        detail: `No updates were required for ${lora.name}.`,
                        life: 3000
                    });
                }
            } else {
                debug.log("Refresh Failed:", result);
                throw new Error(result.message || 'Failed to refresh LoRA');
            }
        } catch (error) {
            console.error("Error refreshing LoRA:", error);
            app.extensionManager.toast.add({
                severity: "error",
                summary: "Refresh Failed",
                detail: `Failed to refresh ${lora.name}. ${error.message}`,
                life: 5000
            });
        }
    }
    

    setupCanvasDropHandling() {
        const canvas = app.canvas.canvas;
        let currentDragData = null;
        let isDragging = false;

        // Remove existing listeners to prevent stacking
        canvas.removeEventListener('dragstart', this.handleDragStart);
        canvas.removeEventListener('drop', this.handleDrop);
        canvas.removeEventListener('dragover', this.handleDragOver);
    
        // Make this available to other methods
        this.handleDragStart = (e) => {
            if (e.dataTransfer.types.includes('application/json')) {
                currentDragData = e.dataTransfer.getData('application/json');
                isDragging = true;
                debug.log("Drag started, cached data");
            }
        };
    
        this.handleDrop = (e) => {
            debug.log("Drop handler called from:", e.target);
            // First, try to get the drag data
            let data = e.dataTransfer?.getData('application/json') || currentDragData;
            if (!data) {
                debug.log("No drop data available, allowing default behavior");
                return; // Let ComfyUI handle it
            }

            // Check if this is our type of data before doing anything else
            try {
                const dragData = JSON.parse(data);
                if (dragData.type !== "comfy-lora") {
                    debug.log("Non-comfy-lora object dropped, allowing default behavior");
                    return; // Let ComfyUI handle it
                }
            } catch (error) {
                debug.log("Error parsing drop data, allowing default behavior", error);
                return; // Let ComfyUI handle it
            }

            // At this point we know it's our lora data, so we can handle the drop
            debug.log("Handling comfy-lora drop");

            // Now we can check the drop location
            const canvasRect = app.canvas.canvas.getBoundingClientRect();
            const dropX = (e.clientX - canvasRect.left) / app.canvas.ds.scale - app.canvas.ds.offset[0];
            const dropY = (e.clientY - canvasRect.top) / app.canvas.ds.scale - app.canvas.ds.offset[1];

            const node = app.graph.getNodeOnPos(dropX, dropY);
            if (node) {
                debug.log("Dropped on a node:", node);
                // Continue processing, as the drop is on a valid Litegraph node
            } else {
                // Check if drop is over the sidebar
                const sidebar = document.querySelector('.lora-sidebar');
                if (sidebar && (sidebar.contains(e.target) || e.target === sidebar)) {
                    debug.log("Drop occurred over sidebar, ignoring");
                    e.stopPropagation();
                    return;
                }
            }
    
            // Early check to ignore non-comfy-lora objects
            try {
                const dragData = JSON.parse(data);
                if (dragData.type !== "comfy-lora") {
                    debug.log("Non-comfy-lora object dropped, ignoring.");
                    return;  // Ignore and allow default behavior
                }
            } catch (error) {
                debug.log("Error parsing drop data, ignoring.", error);
                return;  // Ignore and allow default behavior
            }
    
            // If we reach here, it's a "comfy-lora" object
            debug.log("Comfy-lora object dropped, processing.");
    
            //const canvasRect = canvas.getBoundingClientRect();
            //const dropX = (e.clientX - canvasRect.left) / app.canvas.ds.scale - app.canvas.ds.offset[0];
            //const dropY = (e.clientY - canvasRect.top) / app.canvas.ds.scale - app.canvas.ds.offset[1];
    
            try {
                const dragData = JSON.parse(data);
                if (dragData.type === "comfy-lora") {
                    const loraData = this.loraData.find(l => l.id === dragData.id);
                    if (!loraData) {
                        debug.log("Failed to find LoRA data for id:", dragData.id);
                        return;
                    }

                    debug.log("Found LoRA data for drop:", loraData);

                    // Ensure we have the full path including filename
                    const fullPath = loraData.path || "";
                    const filename = loraData.filename || dragData.id + ".safetensors";  // Fallback to ID if needed

                    const nodeData = {
                        name: loraData.name,
                        reco_weight: loraData.reco_weight,
                        path: loraData.subdir || "",  // Keep this as is
                        filename: filename,
                        trainedWords: loraData.trained_words
                    };

                    debug.log("Set nodedata for drop:", nodeData);
    
                    let attempts = 0;
                    const maxAttempts = 3;
                    
                    const tryCreateNode = () => {
                        attempts++;
                        debug.log(`Attempt ${attempts} to create/update node`);
                    
                        try {
                            const node = app.graph.getNodeOnPos(dropX, dropY);
                    
                            if (node) {
                                if (node.type === "LoraLoader" || node.type === "Power Lora Loader (rgthree)") {
                                    this.updateLoraNode(node, loraData);
                                    debug.log("Successfully updated node");
                                } else if (nodeData.trainedWords?.length > 0) {
                                    // Check if node has any text widgets
                                    const textWidget = node.widgets?.find(w => 
                                        w.name === "text" ||
                                        w.name === "string" ||
                                        w.name === "prompt"
                                    );

                                    if (textWidget) {
                                        const currentText = textWidget.value || "";
                                        let newText = currentText;
                                        let trainedWords = "";

                                        // Handle trained words if they exist
                                        if (nodeData.trainedWords?.length > 0) {
                                            trainedWords = nodeData.trainedWords[0];
                                        }

                                        // If a1111Style is enabled, prefix with LoRA syntax
                                        if (this.a1111Style) {
                                            const loraPath = nodeData.path ? `${nodeData.path}\\` : '';
                                            const loraName = nodeData.filename.replace(/\.[^/.]+$/, ""); // this might not be safe because filenames can we be weird
                                            const loraPart = `${loraPath}${loraName}`;
                                            const weight = nodeData.reco_weight ?? 1;
                                            const weightStr = weight.toString().includes('.') ? weight.toFixed(2) : weight;
                                            trainedWords = `<lora:${loraPart}:${weightStr}>, ${trainedWords}`;
                                        }
                    
                                        if (currentText.length > 0) {
                                            if (currentText.endsWith(", ")) {
                                                newText = currentText + trainedWords;
                                            } else if (currentText.endsWith(",")) {
                                                newText = currentText + " " + trainedWords;
                                            } else {
                                                newText = currentText + ", " + trainedWords;
                                            }
                                        } else {
                                            newText = trainedWords;
                                        }
                    
                                        textWidget.value = newText;
                                        node.setDirtyCanvas(true, true);
                                        debug.log("Successfully added trigger word to text widget");
                                    }
                                }
                            } else {
                                this.createLoraNode(nodeData, dropX, dropY, loraData);
                                debug.log("Successfully created node");
                            }
                    
                            app.graph.setDirtyCanvas(true, true);
                        } catch (err) {
                            debug.log(`Attempt ${attempts} failed:`, err);
                            if (attempts < maxAttempts) {
                                setTimeout(tryCreateNode, attempts * 100);
                            }
                        }
                    };
                    
                    tryCreateNode();
                }
            } catch (error) {
                debug.log("Error processing comfy-lora dropped data:", error);
            } finally {
                currentDragData = null;
                isDragging = false;
            }
        };
    
        canvas.addEventListener('dragover', (e) => {
            if (e.dataTransfer.types.includes('application/json')) {
                e.preventDefault();  // Enable drop events to fire
            }
        }, { passive: false });
    
        canvas.addEventListener('drop', this.handleDrop);
        canvas.addEventListener('dragenter', (e) => e.preventDefault());
        canvas.addEventListener('dragleave', (e) => e.preventDefault());
    
        document.addEventListener('drop', (e) => {
            if (isDragging) {
                this.handleDrop(e);
            }
        });
    
        document.addEventListener('dragend', (e) => {
            if (isDragging) {
                debug.log("Dragend caught with active drag");
                this.handleDrop(e);
            }
        });
    }
    
    
    createLoraNode(nodeData, x, y, loraData) {
        if (this.UseRG3) {
            // Create Power Lora Loader node
            const node = LiteGraph.createNode("Power Lora Loader (rgthree)");
            node.pos = [x, y];

            // Add the node to the graph (this needs to happen before we add widgets)
            app.graph.add(node);

            // Use our existing code to add the lora to the new node
            const widget = node.addNewLoraWidget();

            const weight = loraData.reco_weight ?? 1;
            const loraPath = this.loraPathCalc(loraData);

            widget.value = {
                on: true,
                lora: loraPath,
                strength: weight,
                strengthTwo: null,
            };

            widget.loraInfo = {
                file: loraData.filename.split("/").pop(), // Ensure we get just the filename
                path: loraPath,
                images: [],
            };

            // Handle node resizing
            const computed = node.computeSize();
            const tempHeight = node._tempHeight ?? 15;
            node.size[1] = Math.max(tempHeight, computed[1]);

            node.setDirtyCanvas(true, true);
        } else {
            // Original LoraLoader code
            const node = LiteGraph.createNode("LoraLoader");
            node.pos = [x, y];

            // Set node title
            node.title = `Lora - ${nodeData.name}`;

            // Get recommended weight, default to 1 if not present
            const weight = nodeData.reco_weight ?? 1;

            // Set widget values
            for (const widget of node.widgets) {
                if (widget.name === "lora_name") {
                    widget.value = nodeData.path ? `${nodeData.path}\\${nodeData.filename}` : nodeData.filename;
                } else if (widget.name === "strength_model") {
                    widget.value = weight;
                } else if (widget.name === "strength_clip") {
                    widget.value = weight;
                }
            }

            // Add the node to the graph
            app.graph.add(node);
        }

        // Ensure the canvas is updated
        app.graph.setDirtyCanvas(true, true);
    }

    updateLoraNode(node, loraData) {
        // Get just the filename without path
        const filename = loraData.filename.split("/").pop();

        // Handle different node types
        if (node.type === "LoraLoader") {
            // Update the node title
            node.title = `Lora - ${loraData.name}`;

            // Get recommended weight, default to 1 if not present
            const weight = loraData.reco_weight ?? 1;

            // Update widget values
            for (const widget of node.widgets) {
                if (widget.name === "lora_name") {
                    widget.value = loraData.subdir ? `${loraData.subdir}\\${loraData.filename.split("/").pop()}` : loraData.filename.split("/").pop();
                } else if (widget.name === "strength_model") {
                    widget.value = weight;
                } else if (widget.name === "strength_clip") {
                    widget.value = weight;
                }
            }
        } else if (node.type === "Power Lora Loader (rgthree)") {
            debug.log("Starting update with data:", loraData);

            const widget = node.addNewLoraWidget();
            debug.log("Created widget:", widget);

            const weight = loraData.reco_weight ?? 1;
            const loraPath = this.loraPathCalcUpdate(loraData);

            widget.value = {
                on: true,
                lora: loraPath,
                strength: weight,
                strengthTwo: null,
            };

            widget.loraInfo = {
                file: filename, // Just use the filename
                path: loraPath,
                images: [],
            };

            // Handle node resizing
            const computed = node.computeSize();
            const tempHeight = node._tempHeight ?? 15;
            node.size[1] = Math.max(tempHeight, computed[1]);

            node.setDirtyCanvas(true, true);
        }
        // Ensure the canvas is updated
        app.graph.setDirtyCanvas(true, true);
    }

    showLoraInfo(lora, iconElement) {
        // Check if a popup already exists and remove it
        if (this.currentPopup) {
            this.currentPopup.remove();
        }
    
        // Create the popup container
        const popup = $el("div.model-info-popup", { 
            className: "model-info-popup",
            onmousedown: (e) => {
                // Store the initial mouse down target
                popup.dataset.mouseDownTarget = 'inside';
                e.stopPropagation();
            },
            onmouseleave: () => {
                // Clear the target if mouse leaves the popup
                popup.dataset.mouseDownTarget = '';
            }
        });
    
        // Create the close button
        const closeButton = $el("button", {
            className: "close-button",
            textContent: "×",
            onclick: () => {
                popup.remove();
                document.removeEventListener("click", closePopup);
                this.currentPopup = null;
            }
        });
    
        // Create the content container
        const contentContainer = $el("div.popup-content");

        // Add drag area as first child of content container
        contentContainer.appendChild($el("div.popup-drag-area", {
            draggable: true,
            ondragstart: (e) => {
                const dragData = JSON.stringify({
                    type: "comfy-lora",
                    id: lora.id
                });
                e.dataTransfer.setData("application/json", dragData);
                const img = document.querySelector(`.lora-item img[src*="${encodeURIComponent(lora.id)}"]`);
                if (img) {
                    e.dataTransfer.setDragImage(img, img.width / 2, img.height / 2);
                }
        
                // Let your existing handlers take care of everything else
                this.handleDragStart(e);
            }
        }));

        // Function to update media content
        const updateMediaContent = (updatedLora) => {
            // Remove existing media container if it exists
            const existingMediaContainer = contentContainer.querySelector('.media-container');
            if (existingMediaContainer) {
                existingMediaContainer.remove();
            }

            // Create and append new media container with updated data
            const mediaItems = updatedLora.images || [];
            const mediaContainer = $el("div.media-container");
            contentContainer.appendChild(mediaContainer);

            let currentIndex = 0;
            let prevButton, nextButton;

            const updateMedia = () => {
                mediaContainer.innerHTML = "";
                if (mediaItems.length > 0) {
                    const item = mediaItems[currentIndex];
                    const isVideo = item.type === 'video';
                    
                    const mediaElement = isVideo ? 
                        $el("video", {
                            src: item.url,
                            controls: true,
                            loop: true,
                        }) :
                        $el("img", {
                            style: {
                                opacity: 0,
                                transition: 'opacity 0.3s ease, transform 0.3s ease',
                            }
                        });

                    if (!isVideo) {
                        mediaElement.onload = () => {
                            mediaElement.style.opacity = 1;
                        };
                        mediaElement.src = item.url;
                    }

                    // Add media controls container
                    const mediaControls = $el("div.media-controls", [
                        // Left side controls container
                        $el("div.media-controls-left", [
                            // Info button
                            $el("button.media-control-button", {
                                innerHTML: '<i class="pi pi-info-circle"></i>',
                                title: "Show generation info",
                                onclick: (e) => {
                                    e.stopPropagation();
                                    const item = mediaItems[currentIndex];
                                    const promptInfo = item?.prompt || null;
                                    
                                    if (!promptInfo) {
                                        this.showToast("warn", "No Info", "No generation info available for this image");
                                        return;
                                    }
                                    
                                    // Remove any existing info popup
                                    const existingPopup = document.querySelector('.image-info-popup');
                                    if (existingPopup) existingPopup.remove();
                                    
                                    // Create new popup
                                    const infoPopup = $el("div.image-info-popup", {
                                        onclick: (e) => e.stopPropagation()
                                    }, [
                                        $el("div.image-info-content", {
                                            textContent: promptInfo
                                        })
                                    ]);
                                    
                                    const button = e.currentTarget;
                                    const rect = button.getBoundingClientRect();
                                    
                                    infoPopup.style.position = 'absolute';
                                    infoPopup.style.left = `${rect.right + 10}px`;
                                    infoPopup.style.top = `${rect.top}px`;
                                    
                                    // Ensure popup stays within viewport
                                    setTimeout(() => {
                                        const popupRect = infoPopup.getBoundingClientRect();
                                        if (popupRect.right > window.innerWidth) {
                                            infoPopup.style.left = `${rect.left - popupRect.width - 10}px`;
                                        }
                                        if (popupRect.bottom > window.innerHeight) {
                                            infoPopup.style.top = `${window.innerHeight - popupRect.height - 10}px`;
                                        }
                                    }, 0);
                                    
                                    document.body.appendChild(infoPopup);
                                    
                                    // Close on outside click
                                    const closePopup = (e) => {
                                        if (!infoPopup.contains(e.target) && !button.contains(e.target)) {
                                            infoPopup.remove();
                                            document.removeEventListener('click', closePopup);
                                        }
                                    };
                                    
                                    setTimeout(() => {
                                        document.addEventListener('click', closePopup);
                                    }, 0);
                                }
                            }),
                            // Copy button
                            $el("button.media-control-button", {
                                innerHTML: '<i class="pi pi-clipboard"></i>',
                                title: "Copy generation info",
                                onclick: (e) => {
                                    e.stopPropagation();
                                    const item = mediaItems[currentIndex];
                                    const promptInfo = item?.prompt || null;
                                    
                                    if (!promptInfo) {
                                        this.showToast("warn", "No Info", "No generation info available to copy");
                                        return;
                                    }
                                    
                                    navigator.clipboard.writeText(promptInfo).then(() => {
                                        this.showToast("success", "Copied", "Generation info copied to clipboard");
                                    }).catch(err => {
                                        console.error('Failed to copy prompt:', err);
                                        this.showToast("error", "Copy Failed", "Failed to copy generation info");
                                    });
                                }
                            })
                        ]),
                        // Right side controls container
                        $el("div.media-controls-right", [
                            // Set as preview button
                            $el("button.media-control-button", {
                                innerHTML: '<i class="pi pi-clone"></i>',
                                title: "Set as preview image",
                                onclick: async (e) => {
                                    e.stopPropagation();
                                    try {
                                        const response = await fetch('/lora_sidebar/set_preview', {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({
                                                id: lora.id,
                                                url: item.url
                                            })
                                        });
                                        
                                        if (response.ok) {
                                            // Create new element with cache buster
                                            const newLoraElement = this.createLoraElement(lora, true);
                                            const existingLoraContainer = document.querySelector(`.lora-item img[src*="${encodeURIComponent(lora.id)}"]`)?.closest('.lora-item');
                                            if (existingLoraContainer) {
                                                if (existingLoraContainer.style.width) {
                                                    newLoraElement.style.width = existingLoraContainer.style.width;
                                                }
                                                existingLoraContainer.replaceWith(newLoraElement);
                                                debug.log('We got a response and tried to replce the container.');
                                            }
                                        }
                                    } catch (error) {
                                        console.error('Error setting preview:', error);
                                    }
                                }
                            }),
                            // Pop-out button
                            $el("button.media-control-button", {
                                innerHTML: '<i class="pi pi-window-maximize"></i>',
                                title: "View larger",
                                onclick: (e) => {
                                    e.stopPropagation();
                                    let currentIndex = mediaItems.indexOf(item);
                            
                                    const createPopupContent = (index) => {
                                        const fullSizeUrl = mediaItems[index].url.replace(/\/width=\d+\//, '/');
                                        const promptInfo = mediaItems[index]?.prompt;

                                        return [
                                            // Control buttons container
                                            $el("div.popup-controls", [
                                                // Set as preview button
                                                $el("button.popup-control-button", {
                                                    innerHTML: '<i class="pi pi-clone"></i>',
                                                    title: "Set as preview image",
                                                    onclick: async (e) => {
                                                        e.stopPropagation();
                                                        try {
                                                            const response = await fetch('/lora_sidebar/set_preview', {
                                                                method: 'POST',
                                                                headers: { 'Content-Type': 'application/json' },
                                                                body: JSON.stringify({
                                                                    id: lora.id,
                                                                    url: mediaItems[currentIndex].url
                                                                })
                                                            });
                                                            
                                                            if (response.ok) {
                                                                const newLoraElement = this.createLoraElement(lora, true);
                                                                const existingLoraContainer = document.querySelector(`.lora-item img[src*="${encodeURIComponent(lora.id)}"]`)?.closest('.lora-item');
                                                                if (existingLoraContainer) {
                                                                    if (existingLoraContainer.style.width) {
                                                                        newLoraElement.style.width = existingLoraContainer.style.width;
                                                                    }
                                                                    existingLoraContainer.replaceWith(newLoraElement);
                                                                    this.showToast("success", "LoRA Preview Thumbnail Updated.");
                                                                }
                                                            }
                                                        } catch (error) {
                                                            console.error('Error setting preview:', error);
                                                        }
                                                    }
                                                }),
                                                // Close button
                                                $el("button.popup-control-button", {
                                                    innerHTML: '<i class="pi pi-times"></i>',
                                                    title: "Close",
                                                    onclick: (e) => {
                                                        e.stopPropagation();
                                                        popup.remove();
                                                    }
                                                })
                                            ]),
                                            // Navigation buttons
                                            $el("button.nav-button.prev", {
                                                innerHTML: '<i class="pi pi-chevron-left"></i>',
                                                onclick: (e) => {
                                                    e.stopPropagation();
                                                    currentIndex = (currentIndex - 1 + mediaItems.length) % mediaItems.length;
                                                    imageContainer.replaceChildren(...createPopupContent(currentIndex));
                                                },
                                                style: { display: mediaItems.length > 1 ? 'flex' : 'none' }
                                            }),
                                            $el("button.nav-button.next", {
                                                innerHTML: '<i class="pi pi-chevron-right"></i>',
                                                onclick: (e) => {
                                                    e.stopPropagation();
                                                    currentIndex = (currentIndex + 1) % mediaItems.length;
                                                    imageContainer.replaceChildren(...createPopupContent(currentIndex));
                                                },
                                                style: { display: mediaItems.length > 1 ? 'flex' : 'none' }
                                            }),
                                            $el("img", {
                                                src: fullSizeUrl,
                                                onclick: (e) => e.stopPropagation()
                                            }),

                                            // New prompt display container
                                            promptInfo && $el("div.popup-prompt-container", {
                                                onclick: (e) => e.stopPropagation()
                                            }, [
                                                $el("div.popup-prompt-content", {
                                                    textContent: promptInfo
                                                }),
                                                $el("button.popup-prompt-copy", {
                                                    title: "Copy generation info",
                                                    innerHTML: '<i class="pi pi-clipboard"></i>',
                                                    onclick: (e) => {
                                                        e.stopPropagation();
                                                        navigator.clipboard.writeText(promptInfo).then(() => {
                                                            this.showToast("success", "Copied", "Generation info copied to clipboard");
                                                        }).catch(err => {
                                                            console.error('Failed to copy prompt:', err);
                                                            this.showToast("error", "Copy Failed", "Failed to copy generation info");
                                                        });
                                                    }
                                                })
                                            ])
                                        ].filter(Boolean); // Remove null elements if no prompt
                                    };

                                    const imageContainer = $el("div.image-container");
                                    const popup = $el("div.image-popup", {
                                        onclick: (e) => {
                                            if (e.target === popup) {
                                                e.stopPropagation();
                                                popup.remove();
                                            }
                                        }
                                    }, [imageContainer]);
                                    imageContainer.replaceChildren(...createPopupContent(currentIndex));
                                    
                                    document.body.appendChild(popup);

                                    // Close when clicking outside or pressing escape
                                    const closePopup = (e) => {
                                        if (e.key === 'Escape') {
                                            e.stopPropagation();  // Prevent the escape from bubbling
                                            popup.remove();
                                            document.removeEventListener('keydown', closePopup);
                                        }
                                    };

                                    // Also close if clicking on the info popup background
                                    const infoPopup = document.querySelector('.model-info-popup');
                                    if (infoPopup) {
                                        infoPopup.addEventListener('click', (e) => {
                                            // Only handle clicks on the actual background of the info popup
                                            if (e.target === infoPopup) {
                                                e.stopPropagation();  // Prevent the click from closing the info popup
                                                popup.remove();
                                            }
                                        });
                                    }

                                    // Close if esc is pressed
                                    document.addEventListener('keydown', closePopup);
                                }
                            })
                        ])
                    ]);

                    mediaContainer.appendChild(mediaElement);
                    mediaContainer.appendChild(mediaControls);
                }

                // Re-append carousel buttons
                if (prevButton && nextButton) {
                    mediaContainer.appendChild(prevButton);
                    mediaContainer.appendChild(nextButton);
                }
            };

            if (mediaItems.length > 1) {
                prevButton = $el("button", {
                    textContent: "←",
                    onclick: () => {
                        currentIndex = (currentIndex - 1 + mediaItems.length) % mediaItems.length;
                        updateMedia();
                    },
                    className: "carousel-button prev"
                });

                nextButton = $el("button", {
                    textContent: "→",
                    onclick: () => {
                        currentIndex = (currentIndex + 1) % mediaItems.length;
                        updateMedia();
                    },
                    className: "carousel-button next"
                });

                mediaContainer.appendChild(prevButton);
                mediaContainer.appendChild(nextButton);
            }

            updateMedia();
        };

        const updateTrainedWords = (updatedLora) => {
            const existingWordsContainer = contentContainer.querySelector('.trained-words');
            if (existingWordsContainer && updatedLora.trained_words?.length > 0) {
                existingWordsContainer.replaceWith($el("div.trained-words", [
                    $el("h4", { textContent: "Trained Words:" }),
                    $el("div.word-pills", updatedLora.trained_words.map(word => 
                        $el("span.word-pill", { 
                            textContent: word,
                            onclick: () => this.copyToClipboard(word)
                        })
                    )),
                    $el("button.copy-all-button", {
                        textContent: "Copy All",
                        onclick: () => this.copyToClipboard(updatedLora.trained_words.join(", "))
                    })
                ]));
            }
        };
        
        const updateTags = (updatedLora) => {
            const existingTagsContainer = contentContainer.querySelector('.tags');
            if (existingTagsContainer && updatedLora.tags?.length > 0) {
                existingTagsContainer.replaceWith($el("div.tags", [
                    $el("h4", { textContent: "Tags:" }),
                    $el("div.word-pills", updatedLora.tags.map(tag => 
                        $el("span.word-pill", { 
                            textContent: tag,
                            onclick: () => this.copyToClipboard(tag)
                        })
                    ))
                ]));
            }
        };

        const fetchImagesIfNeeded = async () => {
            debug.log("Checking for images:", {
                hasImages: !!lora.images,
                imageCount: lora.images?.length,
                baseModel: lora.baseModel,
                versionId: lora.versionId
            });
        
            if (!lora.images || lora.images.length === 0) {
                // Only fetch for non-custom LoRAs that have a versionId
                if (lora.baseModel !== 'custom' && lora.versionId) {
                    debug.log("Fetching images for lora:", lora.name);
                    try {
                        const response = await fetch(`/lora_sidebar/refresh/${lora.versionId}`, {
                            method: 'POST'
                        });
                        
                        debug.log("Response received:", response.status);
                        if (response.ok) {
                            const result = await response.json();
                            debug.log("Got refresh result:", result);
                            if (result.status === 'success' && result.data) {
                                // Update the lora object with new data
                                Object.assign(lora, result.data);
                                // Update the media content
                                updateMediaContent(lora);
                                updateTrainedWords(lora);
                                updateTags(lora);
                            }
                        }
                    } catch (error) {
                        console.error('Error fetching LoRA images:', error);
                    }
                } else {
                    debug.log("Skipping image fetch:", {
                        isCustom: lora.baseModel === 'custom',
                        hasVersionId: !!lora.versionId
                    });
                }
            }
        };

        // Add Fav star and CivitAI link if modelId is available
        const topRow = $el("div.info-top-row", {
            style: {
                display: "flex",
                justifyContent: "flex-start",
                alignItems: "center",
                marginBottom: "3px"
            }
        });
        
        const leftSection = $el("div.left-section");
        
        if (lora.modelId) {
            const civitAiLink = $el("a", {
                href: `https://civitai.com/models/${lora.modelId}`,
                textContent: `View on CivitAI`,
                target: "_blank",
                className: "civitai-link"
            });
            leftSection.appendChild(civitAiLink);
        }
        
        // Create favorite toggle
        const favoriteToggle = $el("i", {
            className: `favorite-toggle pi ${lora.favorite ? 'pi-star-fill' : 'pi-star'}`,
            title: 'Add to Favorites',
            style: {
                cursor: "pointer",
                color: lora.favorite ? "#FFD700" : "#888",
                fontSize: "1.2em",
                transition: "color 0.2s ease"
            },
            onclick: async (e) => {
                e.stopPropagation();
                await this.toggleFavorite(lora);
                // Update the star appearance after toggle
                favoriteToggle.className = `favorite-toggle pi ${lora.favorite ? 'pi-star-fill' : 'pi-star'}`;
                favoriteToggle.style.color = lora.favorite ? "#FFD700" : "#888";
            }
        });

        // Add sections to top row
        topRow.appendChild(leftSection);
        topRow.appendChild(favoriteToggle);
        contentContainer.appendChild(topRow);

        const createDescriptionPopup = (description, event) => {
            // Remove any existing description popup
            const existingPopup = document.querySelector('.description-popup');
            if (existingPopup) {
                existingPopup.remove();
            }

            if (!description) return;

            const popup = $el("div.description-popup", [
                $el("button.close-button", {
                    innerHTML: "×",
                    onclick: (e) => {
                        e.stopPropagation();
                        popup.remove();
                    }
                }),
                $el("div", {
                    innerHTML: description
                })
            ]);

            // Check if the description contains any media elements
            if (description.includes('<img') || description.includes('<video')) {
                popup.classList.add('has-media');
            }

            // Position popup
            document.body.appendChild(popup);
            const rect = popup.getBoundingClientRect();
            
            // Calculate position
            let left = event.clientX + 10;
            let top = event.clientY + 10;

            // Adjust for screen edges
            if (left + rect.width > window.innerWidth - 20) {
                left = window.innerWidth - rect.width - 20;
            }
            if (top + rect.height > window.innerHeight - 20) {
                top = window.innerHeight - rect.height - 20;
            }

            // Ensure minimum left margin
            left = Math.max(20, left);
            top = Math.max(20, top);

            popup.style.left = `${left}px`;
            popup.style.top = `${top}px`;

            // Stop propagation on popup clicks to prevent closing the main info popup
            popup.addEventListener('click', (e) => {
                e.stopPropagation();
            });

            // Handle outside clicks to close the description popup
            const handleOutsideClick = (e) => {
                if (!popup.contains(e.target) && !e.target.closest('.description-icon')) {
                    popup.remove();
                    document.removeEventListener('click', handleOutsideClick);
                }
            };

            // Small delay to prevent immediate closing
            setTimeout(() => {
                document.addEventListener('click', handleOutsideClick);
            }, 100);

            return popup;
        };

        const createWeightEditor = (lora, contentContainer) => {
            let weight = lora.reco_weight || 1;
            let isEditing = false;
        
            const createWeightDisplay = () => {
                const container = $el("div.weight-container", [
                    $el("h4", { textContent: "Recommended Weight:" })
                ]);
        
                const displayContainer = $el("div.weight-display");
                
                const updateDisplay = () => {
                    // Remove all child elements properly
                    while (displayContainer.firstChild) {
                        displayContainer.removeChild(displayContainer.firstChild);
                    }
                    
                    if (isEditing) {
                        // Show input and save icon
                        const input = $el("input.weight-input", {
                            type: "number",
                            value: weight,
                            step: "0.1",
                            min: "-10",
                            max: "10",
                            onkeydown: (e) => {
                                e.stopPropagation(); // Prevent event bubbling
                                if (e.key === 'Enter') {
                                    handleSave(e.target.value);
                                }
                                if (e.key === 'Escape') {
                                    isEditing = false;
                                    updateDisplay();
                                }
                            },
                            onclick: (e) => e.stopPropagation() // Prevent event bubbling
                        });
        
                        const saveIcon = $el("i.weight-save-icon.pi.pi-check", {
                            onclick: (e) => {
                                e.stopPropagation(); // Prevent event bubbling
                                handleSave(input.value);
                            }
                        });
        
                        displayContainer.appendChild(input);
                        displayContainer.appendChild(saveIcon);
                        
                        // Focus the input
                        setTimeout(() => input.focus(), 0);
                    } else {
                        // Show value and edit icon
                        const valueSpan = $el("span.weight-value", {
                            textContent: weight
                        });
        
                        const editIcon = $el("i.weight-edit-icon.pi.pi-pen-to-square", {
                            onclick: (e) => {
                                e.stopPropagation(); // Prevent event bubbling
                                isEditing = true;
                                updateDisplay();
                            }
                        });
        
                        displayContainer.appendChild(valueSpan);
                        displayContainer.appendChild(editIcon);
                    }
                };
        
                const handleSave = async (newValue) => {
                    const numValue = parseFloat(newValue);
                    if (isNaN(numValue) || numValue < -10 || numValue > 10) {
                        app.ui.dialog.show("Error", "Please enter a valid number between -10 and 10");
                        return;
                    }
                
                    try {
                        const response = await api.fetchApi('/lora_sidebar/update_info', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                id: lora.id,
                                field: 'reco_weight',
                                value: numValue
                            })
                        });
                
                        const result = await response.json();
                        
                        if (result.status === 'success') {
                            // Update local state
                            lora.reco_weight = numValue;
                            weight = numValue;
                            isEditing = false;
                            updateDisplay();
                            
                            // Also update user_edits in local state if it's returned
                            if (result.user_edits) {
                                lora.user_edits = result.user_edits;
                            }
                            this.showToast("success", "Weight Updated", `Recommended weight updated to ${numValue}`);
                        } else {
                            throw new Error(result.message || 'Failed to update weight');
                        }
                    } catch (error) {
                        console.error("Error updating weight:", error);
                        this.showToast("error", "Update Failed", "Failed to update recommended weight");
                        
                        // Revert to previous value in case of error
                        updateDisplay();
                    }
                };
        
                container.appendChild(displayContainer);
                updateDisplay();
                return container;
            };
        
            const weightDisplay = createWeightDisplay();
            
            // Insert weight display after name container but before trained words
            const trainedWords = contentContainer.querySelector('.trained-words');
            if (trainedWords) {
                contentContainer.insertBefore(weightDisplay, trainedWords);
            } else {
                contentContainer.appendChild(weightDisplay);
            }
        };

        const createVersionIdEditor = (lora, contentContainer) => {
            // Only hide editor if both modelId and versionId are not null
            if (lora.modelId !== null && lora.versionId !== null) return;
        
            let isEditing = false;
        
            const container = $el("div.version-id-container", [
                $el("h4", { textContent: "Version ID:" })
            ]);
        
            const displayContainer = $el("div.version-display");
        
            const updateDisplay = () => {
                displayContainer.innerHTML = '';
            
                if (isEditing) {
                    const input = $el("input.version-input", {
                        type: "number",
                        value: lora.versionId || "", // Show existing versionId if it exists
                        placeholder: "Enter Version ID",
                        onkeydown: (e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') handleSave(e.target.value);
                            if (e.key === 'Escape') {
                                isEditing = false;
                                updateDisplay();
                            }
                        },
                        onclick: (e) => e.stopPropagation()
                    });
            
                    const saveIcon = $el("i.version-save-icon.pi.pi-check", {
                        onclick: (e) => {
                            e.stopPropagation();
                            handleSave(input.value);
                        }
                    });
            
                    displayContainer.appendChild(input);
                    displayContainer.appendChild(saveIcon);
                    setTimeout(() => input.focus(), 0);
                } else {
                    const valueSpan = $el("span.version-value", {
                        // Show the actual versionId if it exists, otherwise "Custom"
                        textContent: lora.versionId || "Custom"
                    });
            
                    const editIcon = $el("i.version-edit-icon.pi.pi-pen-to-square", {
                        onclick: (e) => {
                            e.stopPropagation();
                            isEditing = true;
                            updateDisplay();
                        }
                    });
            
                    displayContainer.appendChild(valueSpan);
                    displayContainer.appendChild(editIcon);
                }
            };
       
            const handleSave = async (value) => {
                const versionId = parseInt(value);
                if (isNaN(versionId) || versionId <= 0) {
                    app.ui.dialog.show("Error", "Please enter a valid Version ID");
                    return;
                }
        
                try {
                    const response = await api.fetchApi('/lora_sidebar/update_info', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            id: lora.id,
                            field: 'versionId',
                            value: versionId
                        })
                    });
        
                    const result = await response.json();
                    if (result.status === 'success') {
                        // Update local state
                        lora.versionId = versionId;
                        if (result.modelId) lora.modelId = result.modelId;
                        
                        // Remove the editor since we now have a valid versionId
                        container.remove();
                        
                        // Refresh the LoRA info to fetch new data
                        this.refreshLora(lora);
                    } else {
                        throw new Error(result.message || 'Failed to update Version ID');
                    }
                } catch (error) {
                    console.error("Error updating Version ID:", error);
                    this.showToast("error", "Update Failed", "Failed to update Version ID");
                }
            };
        
            container.appendChild(displayContainer);
            updateDisplay();
            return container;
        };

        // nameContainer creation
        const nameContainer = $el("div.name-container");

        // Create a row for name and icon
        const nameRow = $el("div.name-row", {
            style: {
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                position: 'relative'  // For positioning the save button
            }
        });
        
        // Create editable name element
        const nameElement = $el("h3", { 
            textContent: lora.name, 
            className: "lora-name",
            style: {
                cursor: 'default'
            },
            ondblclick: async (e) => {
                if (e.target !== nameElement) return;
        
                const originalName = lora.name;
                
                // Create container for input and save button
                const editContainer = $el("div", {
                    style: {
                        position: 'relative',
                        width: '100%'
                    },
                    onclick: (e) => e.stopPropagation()  // Prevent clicks from reaching the lora info popup
                });
        
                const input = $el("input", {
                    type: "text",
                    value: originalName,
                    style: {
                        width: '100%',
                        fontSize: '1rem',         // Default font size
                        fontWeight: 'normal',     // Normal weight
                        backgroundColor: '#2a2a2a',
                        border: '1px solid #444',
                        borderRadius: '4px',
                        color: 'inherit',
                        padding: '4px 8px',
                        margin: '0'
                    },
                    onkeydown: async (e) => {
                        e.stopPropagation();
                        if (e.key === 'Escape') {
                            nameElement.textContent = originalName;
                            return;
                        }
                        if (e.key === 'Enter') {
                            await saveName(e.target.value);
                        }
                    },
                    onclick: (e) => e.stopPropagation(),
                    onmousedown: (e) => e.stopPropagation(),
                    onmouseup: (e) => e.stopPropagation()
                });
        
                // Create save button
                const saveButton = $el("div", {
                    style: {
                        position: 'absolute',
                        right: '3px',  // Move slightly inward
                        top: '100%',
                        marginTop: '1px',
                        padding: '1px 3px',  // Much smaller padding
                        backgroundColor: '#333',  // Dark grey background
                        borderRadius: '1px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                    },
                    onclick: async (e) => {
                        e.stopPropagation();
                        await saveName(input.value);
                    }
                }, [
                    $el("i.pi.pi-check", {
                        style: {
                            color: '#4CAF50',  // Green checkmark
                            fontSize: '0.8em'  // Smaller icon
                        }
                    })
                ]);
        
                const saveName = async (newValue) => {
                    const newName = newValue.trim();
                    if (newName && newName !== originalName) {
                        try {
                            const response = await api.fetchApi('/lora_sidebar/update_info', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    id: lora.id,
                                    field: 'name',
                                    value: newName
                                })
                            });
        
                            if (response.ok) {
                                lora.name = newName;
                                nameElement.textContent = newName;
                                this.showToast("success", "Updated", "Name updated successfully");
                            } else {
                                throw new Error('Failed to update name');
                            }
                        } catch (error) {
                            console.error("Error updating name:", error);
                            nameElement.textContent = originalName;
                            this.showToast("error", "Update Failed", "Failed to update name");
                        }
                    } else {
                        nameElement.textContent = originalName;
                    }
                };
        
                // Clear the name element and add our container
                nameElement.textContent = '';
                editContainer.appendChild(input);
                editContainer.appendChild(saveButton);
                nameElement.appendChild(editContainer);
                
                // Focus and select the input
                input.focus();
                input.scrollLeft = 0;
                input.setSelectionRange(0, 0);
            }
        });
        
        nameRow.appendChild(nameElement);
        
        // Add description icon separately
        if (lora.model_desc) {
            const descriptionIcon = $el("i.description-icon.pi.pi-info-circle", {
                onclick: (e) => {
                    e.stopPropagation();
                    createDescriptionPopup(lora.model_desc, e);
                }
            });
            nameRow.appendChild(descriptionIcon);
        }
        
        nameContainer.appendChild(nameRow);

        // Add label pills container
        const labelPills = $el("div.label-pills");

        // Add base model pill if available
        if (lora.baseModel) {
            labelPills.appendChild(this.createEditablePill('baseModel', lora.baseModel, lora));
        }

        // Add type pill if available
        if (lora.type) {
            labelPills.appendChild(this.createEditablePill('type', lora.type, lora));
        }
        
        // Only append the labels container if we have pills to show
        if (labelPills.children.length > 0) {
            nameContainer.appendChild(labelPills);
        }

        const versionIdEditor = createVersionIdEditor.call(this, lora, contentContainer);
        versionIdEditor && contentContainer.appendChild(versionIdEditor);

        // Add version information in a version container
        if (lora.versionName || lora.version_desc) {
            const versionContainer = $el("div.version-info");
    
            if (lora.versionName) {
                const versionElement = $el("p", { 
                    textContent: `Version: ${lora.versionName}`, 
                    className: "version-name" 
                });
                versionContainer.appendChild(versionElement);
            }
            
            if (lora.version_desc) {
                // Create a container for the version description
                const versionDescContainer = $el("div", { 
                    className: "version-desc-container",
                    style: {
                        maxHeight: '200px',  // Limit initial height
                        overflowY: 'auto',   // Add scroll if content is too long
                        marginTop: '8px'     // Add some spacing
                    }
                });
        
                // Create the description element that will hold the HTML content
                const versionDescElement = $el("div", { 
                    className: "version-desc",
                    innerHTML: this.sanitizeHTML(lora.version_desc), // Sanitize and set HTML content
                    style: {
                        padding: '4px',
                        fontSize: '0.9em',
                        lineHeight: '1.4'
                    }
                });
        
                // Add expand/collapse functionality if content is long
                versionDescContainer.appendChild(versionDescElement);
                
                // After adding to DOM, check if we need expand/collapse
                setTimeout(() => {
                    if (versionDescElement.scrollHeight > 200) {
                        const expandButton = $el("button", {
                            className: "expand-desc-button",
                            textContent: "Show More",
                            style: {
                                marginTop: '4px',
                                padding: '2px 8px',
                                fontSize: '0.8em',
                                opacity: '0.8'
                            },
                            onclick: (e) => {
                                e.stopPropagation();
                                if (versionDescContainer.style.maxHeight === 'none') {
                                    versionDescContainer.style.maxHeight = '200px';
                                    expandButton.textContent = "Show More";
                                } else {
                                    versionDescContainer.style.maxHeight = 'none';
                                    expandButton.textContent = "Show Less";
                                }
                            }
                        });
                        versionContainer.appendChild(expandButton);
                    }
                }, 0);
                
                versionContainer.appendChild(versionDescContainer);
            }
            
            nameContainer.appendChild(versionContainer);
        }

        contentContainer.appendChild(nameContainer);

        // Add subdir information
        if (lora.subdir) {
            const subdirElement = $el("p", { 
                textContent: `Subdirectory: ${lora.subdir}`, 
                className: "lora-subdir" 
            });
            contentContainer.appendChild(subdirElement);
        }

        createWeightEditor(lora, contentContainer);

        // Add trained words
        const trainedWordsContainer = $el("div.trained-words");
        this.createEditableTagSection('trained_words', lora, trainedWordsContainer);
        $el("button.copy-all-button", {
            textContent: "Copy All",
            onclick: () => this.copyToClipboard(updatedLora.trained_words.join(", "))
        })
        contentContainer.appendChild(trainedWordsContainer);

        // Add tags
        const tagsContainer = $el("div.tags");
        this.createEditableTagSection('tags', lora, tagsContainer);
        contentContainer.appendChild(tagsContainer);

        // Update initial media content
        updateMediaContent(lora);
        
        // Fetch images if needed
        fetchImagesIfNeeded();        
        // Append the close button and content container to popup
        popup.appendChild(closeButton);
        popup.appendChild(contentContainer);

        // Add NSFW warning if applicable
        if (this.isNSFW(lora)) {
            const nsfwWarning = $el("p.nsfw-warning", { 
                textContent: lora.nsfw 
                    ? "This LoRA contains NSFW content" 
                    : `This LoRA has an NSFW level of ${lora.nsfwLevel}`,
                style: {
                    color: "#ff4444",
                    fontWeight: "bold"
                }
            });
            contentContainer.appendChild(nsfwWarning);
        }

        const createButtonRow = () => {
            const buttonRow = $el("div.button-row");

            // Refresh Button
            const refreshButton = $el("button", {
                className: "info-button icon-button refresh-button",
                title: "Refresh LoRA Data",
                innerHTML: '<i class="pi pi-sync"></i>',
                onclick: async (e) => {
                    e.stopPropagation();
                    await this.refreshLora(lora);
                    
                    // Find the updated lora data
                    const updatedLora = this.loraData.find(l => l.id === lora.id);
                    if (updatedLora) {
                        // Remove current popup
                        if (this.currentPopup) {
                            this.currentPopup.remove();
                        }
                        // Show new popup with updated data
                        this.showLoraInfo(updatedLora, null);
                    }
                }
            });
            buttonRow.appendChild(refreshButton);
        
            // NSFW Toggle Button
            const nsfwButton = $el("button", {
                className: `info-button nsfw-toggle nsfw-${lora.nsfw ? 'true' : 'false'}`,
                title: "NSFW Flag - Green = False, Red = True",
                innerHTML: `<i class="pi ${lora.nsfw ? 'pi-flag-fill' : 'pi-flag'}"></i>`,
                onclick: async (e) => {
                    e.stopPropagation();
                    try {
                        const response = await api.fetchApi('/lora_sidebar/update_info', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                id: lora.id,
                                field: 'nsfw',
                                value: !lora.nsfw
                            })
                        });
            
                        const result = await response.json();
                        
                        if (result.status === 'success' || result.status === 'warning') {
                            // Update flag in the passed lora object
                            lora.nsfw = !lora.nsfw;

                            // Update in both main arrays
                            const loraInData = this.loraData.find(l => l.id === lora.id);
                            if (loraInData) {
                                loraInData.nsfw = lora.nsfw;
                            }
                            const loraInFiltered = this.filteredData.find(l => l.id === lora.id);
                            if (loraInFiltered) {
                                loraInFiltered.nsfw = lora.nsfw;
                            }

                            nsfwButton.innerHTML = `<i class="pi ${lora.nsfw ? 'pi-flag-fill' : 'pi-flag'}"></i>`;
                            nsfwButton.className = `info-button nsfw-toggle nsfw-${lora.nsfw ? 'true' : 'false'}`;
                            
                            // Store user edits if provided
                            if (result.user_edits) {
                                lora.user_edits = result.user_edits;
                            }

                            // Update category info if provided
                            if (result.categoryInfo) {
                                this.categoryInfo = result.categoryInfo;
                            }

                            // Update the visual representation in the sidebar
                            const existingLoraContainer = document.querySelector(
                                `.lora-item img[src*="${encodeURIComponent(lora.id)}"]`
                            )?.closest('.lora-item');
                            
                            if (existingLoraContainer) {
                                const newLoraElement = this.createLoraElement(lora, true);
                                if (existingLoraContainer.style.width) {
                                    newLoraElement.style.width = existingLoraContainer.style.width;
                                }
                                existingLoraContainer.replaceWith(newLoraElement);
                            }

                            // Smoothly transition the popup
                            if (this.currentPopup) {
                                this.currentPopup.classList.add('hide');
                                await new Promise(resolve => setTimeout(resolve, 200)); // Wait for fade out
                                this.currentPopup.remove();
                                const newPopup = this.showLoraInfo(lora, null);
                                // Force a reflow before adding the show class
                                newPopup.offsetHeight;
                                newPopup.classList.add('show');
                            }
                            
                            this.showToast("success", "NSFW Flag Updated", `NSFW flag set to ${lora.nsfw}`);
                        } else {
                            throw new Error(result.message || 'Failed to update NSFW flag');
                        }
                    } catch (error) {
                        console.error("Error updating NSFW flag:", error);
                        this.showToast("error", "Update Failed", "Failed to update NSFW flag");
                    }
                }
            });
            buttonRow.appendChild(nsfwButton);
        
            // Upload Image Button
            const uploadButton = $el("button", {
                className: "info-button icon-button",
                title: "Add / Upload Image",
                innerHTML: '<i class="pi pi-camera"></i>',
                onclick: (e) => {
                    e.stopPropagation();
                    this.createUploadPopup(lora);
                }
            });
            buttonRow.appendChild(uploadButton);

            // File Details Button
            const fileDetailsButton = $el("button", {
                className: "info-button icon-button",
                title: "LoRA File Details",
                innerHTML: '<i class="pi pi-file"></i>',
                onclick: (e) => {
                    e.stopPropagation();
                    this.showFileDetails(lora);
                }
            });
            buttonRow.appendChild(fileDetailsButton);

            // Delete button
            const deleteButton = $el("button", {
                className: "info-button icon-button delete-button",
                title: "Remove LoRA",
                innerHTML: '<i class="pi pi-trash"></i>',
                onclick: (e) => {
                    e.stopPropagation();
                    this.confirmDeleteLora(lora);
                }
            });
            buttonRow.appendChild(deleteButton);
        
            return buttonRow;
        };
        
        // Add the button row to the content container (no await needed)
        contentContainer.appendChild(createButtonRow());
    
        // Position the popup
        const sidebar = document.querySelector('.lora-sidebar');
        const sidebarRect = sidebar.getBoundingClientRect();
        
        popup.style.position = 'fixed';
        popup.style.left = `${sidebarRect.left + 10}px`;  // 10px padding from left
        popup.style.top = '50%';
        popup.style.transform = 'translateY(-50%)';
        popup.style.maxHeight = '80vh';
        popup.style.overflowY = 'auto';
        popup.style.width = `${sidebarRect.width - 20}px`;  // 20px total padding
    
        // Append the popup to the body
        document.body.appendChild(popup);

        // Add show class to trigger transition
        setTimeout(() => popup.classList.add('show'), 0);
    
        // Close the popup when clicking outside (if persistence is disabled)
        const closePopup = (event) => {
            if (!this.infoPersist && !popup.contains(event.target) && event.target !== iconElement) {
                popup.remove();
                document.removeEventListener("click", closePopup);
                this.currentPopup = null;
            }
        };

        // Only add the click-outside listener if persistence is disabled
        if (!this.infoPersist) {
            setTimeout(() => {
                document.addEventListener("click", closePopup);
            }, 0);
        }

        // Update the current popup reference
        this.currentPopup = popup;
        return popup;
    }

    copyToClipboard(text) {
        navigator.clipboard.writeText(text).then(() => {
            this.showToast("success", "Copied", "Text copied to clipboard.");
        }).catch(err => {
            console.error('Failed to copy text:', err);
            this.showToast("error", "Copy Failed", "Failed to copy text to clipboard.");
        });
    }

    removePreviousPopups() {
        const existingPopups = document.querySelectorAll('.confirm-delete-popup');
        existingPopups.forEach(popup => popup.remove());
    }

    createEditablePill(pillType, value, lora) {
        const isModel = pillType === 'baseModel';
        const field = isModel ? 'baseModel' : 'type';
        let isEditing = false;
    
        // Get autocomplete suggestions from existing data
        const getAutocompleteSuggestions = (input) => {
            const searchTerm = input.toLowerCase();
            const existingValues = new Set(
                this.loraData
                    .map(lora => lora[field])
                    .filter(Boolean) // Remove null/undefined
            );
            return Array.from(existingValues)
                .filter(val => val.toLowerCase().includes(searchTerm));
        };
    
        const pill = $el("span.label-pill", {
            className: `label-pill ${isModel ? 'model' : 'type'}`,
            style: {
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                position: 'relative'
            }
        }, [
            $el("span", { textContent: value }),
            $el("i.pi.pi-pencil", {
                style: {
                    cursor: 'pointer',
                    fontSize: '0.8em',
                    opacity: '0.7'
                },
                onclick: (e) => {
                    e.stopPropagation();
                    if (!isEditing) {
                        isEditing = true;
                        showEditInput();
                    }
                }
            })
        ]);
    
        const showEditInput = () => {
            // Clear the pill content
            while (pill.firstChild) {
                pill.removeChild(pill.firstChild);
            }
    
            // Create autocomplete container
            const autocompleteContainer = $el("div.autocomplete-container", {
                style: {
                    position: 'absolute',
                    top: '100%',
                    left: '0',
                    backgroundColor: '#333',
                    border: '1px solid #444',
                    borderRadius: '4px',
                    width: '100%',
                    maxHeight: '150px',
                    overflowY: 'auto',
                    zIndex: '1000',
                    display: 'none'
                }
            });
    
            const input = $el("input", {
                type: "text",
                value: value,
                style: {
                    width: '100px',
                    backgroundColor: 'transparent',
                    border: 'none',
                    color: 'inherit',
                    padding: '2px',
                    fontSize: 'inherit'
                },
                oninput: (e) => {
                    const suggestions = getAutocompleteSuggestions(e.target.value);
                    updateAutocompleteSuggestions(suggestions);
                },
                onkeydown: async (e) => {
                    if (e.key === 'Escape') {
                        isEditing = false;
                        restorePill();
                        return;
                    }
                    if (e.key === 'Enter' && e.target.value.trim()) {
                        e.preventDefault();
                        try {
                            const response = await api.fetchApi('/lora_sidebar/update_info', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    id: lora.id,
                                    field: field,
                                    value: e.target.value.trim()
                                })
                            });
    
                            if (response.ok) {
                                value = e.target.value.trim();
                                lora[field] = value;
                                isEditing = false;
                                restorePill();
                                this.showToast("success", "Updated", `Updated ${isModel ? 'model' : 'type'}`);
                            }
                        } catch (error) {
                            console.error("Error updating:", error);
                            this.showToast("error", "Update Failed", "Failed to update");
                        }
                    }
                }
            });
    
            const saveIcon = $el("i.weight-save-icon.pi.pi-check", {
                style: {
                    cursor: 'pointer',
                    marginLeft: '5px'
                },
                onclick: () => {
                    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
                }
            });
    
            const updateAutocompleteSuggestions = (suggestions) => {
                autocompleteContainer.innerHTML = '';
                if (suggestions.length > 0) {
                    suggestions.forEach(suggestion => {
                        const item = $el("div.autocomplete-item", {
                            textContent: suggestion,
                            style: {
                                padding: '5px 10px',
                                cursor: 'pointer',
                                hover: {
                                    backgroundColor: '#444'
                                }
                            },
                            onclick: () => {
                                input.value = suggestion;
                                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
                            }
                        });
                        autocompleteContainer.appendChild(item);
                    });
                    autocompleteContainer.style.display = 'block';
                } else {
                    autocompleteContainer.style.display = 'none';
                }
            };
    
            const restorePill = () => {
                while (pill.firstChild) {
                    pill.removeChild(pill.firstChild);
                }
                pill.appendChild($el("span", { textContent: value }));
                pill.appendChild($el("i.pi.pi-pencil", {
                    style: {
                        cursor: 'pointer',
                        fontSize: '0.8em',
                        opacity: '0.7'
                    },
                    onclick: (e) => {
                        e.stopPropagation();
                        if (!isEditing) {
                            isEditing = true;
                            showEditInput();
                        }
                    }
                }));
            };
    
            pill.appendChild(input);
            pill.appendChild(saveIcon);
            pill.appendChild(autocompleteContainer);
            
            // Focus input after appending
            setTimeout(() => input.focus(), 0);
    
            // Click outside to close autocomplete
            document.addEventListener('click', (e) => {
                if (!pill.contains(e.target)) {
                    autocompleteContainer.style.display = 'none';
                }
            });
        };
    
        return pill;
    }

    createEditableTagSection(type, lora, container) {
        const isTrainedWords = type === 'trained_words';
        const title = isTrainedWords ? "Trained Words:" : "Tags:";
        const items = lora[type] || [];
        let isEditing = false;
    
        const updateSection = (newItems) => {
            while (container.firstChild) {
                container.removeChild(container.firstChild);
            }
    
            // Create header with edit/save button
            const header = $el("div.section-header", {
                style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    marginBottom: '5px'
                }
            }, [
                $el("h4", { textContent: title }),
                $el("i", {
                    className: `weight-${isEditing ? 'save' : 'edit'}-icon pi pi-${isEditing ? 'check' : 'pen-to-square'}`,
                    style: {
                        cursor: 'pointer',
                        fontSize: '0.9em'
                    },
                    onclick: (e) => {
                        e.stopPropagation();
                        isEditing = !isEditing;
                        updateSection(items);
                    }
                })
            ]);
            container.appendChild(header);
    
            if (isEditing) {
                // Edit mode
                const editContainer = $el("div.edit-container", {
                    style: {
                        marginBottom: '10px'
                    }
                });
    
                // Input field with add button
                const inputGroup = $el("div.input-group", {
                    style: {
                        display: 'flex',
                        gap: '5px',
                        marginBottom: '10px'
                    }
                }, [
                    $el("input", {
                        type: "text",
                        placeholder: `Add new ${isTrainedWords ? 'trigger word' : 'tag'}...`,
                        onkeydown: async (e) => {
                            if (e.key === 'Escape') {
                                isEditing = false;
                                updateSection(items);
                                return;
                            }
                            if (e.key === 'Enter' && e.target.value.trim()) {
                                e.preventDefault();
                                const newItem = e.target.value.trim();
                                if (!items.includes(newItem)) {
                                    try {
                                        const response = await api.fetchApi('/lora_sidebar/update_info', {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({
                                                id: lora.id,
                                                field: type,
                                                value: [...items, newItem]
                                            })
                                        });
    
                                        if (response.ok) {
                                            items.push(newItem);
                                            e.target.value = '';
                                            updateSection(items);
                                            this.showToast("success", "Updated", `Added new ${isTrainedWords ? 'trigger word' : 'tag'}`);
                                        }
                                    } catch (error) {
                                        console.error("Error updating:", error);
                                        this.showToast("error", "Update Failed", "Failed to update");
                                    }
                                }
                            }
                        }
                    }),
                    $el("i.pi.pi-plus", {
                        style: {
                            cursor: 'pointer',
                            padding: '5px',
                            color: '#4CAF50',
                            fontSize: '1em'
                        },
                        onclick: (e) => {
                            const input = e.target.previousElementSibling;
                            if (input.value.trim()) {
                                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
                            }
                        }
                    })
                ]);
                editContainer.appendChild(inputGroup);

                // Add focus after appending
                setTimeout(() => {
                    const input = inputGroup.querySelector('input');
                    if (input) input.focus();
                }, 0);
    
                // Current items with delete buttons
                const itemsContainer = $el("div.word-pills", {
                    style: {
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: '5px'
                    }
                });
    
                items.forEach(item => {
                    const pillContainer = $el("div.pill-container", {
                        style: {
                            display: 'flex',
                            alignItems: 'center',
                            gap: '5px'
                        }
                    }, [
                        $el("span.word-pill", { 
                            textContent: item,
                            onclick: () => this.copyToClipboard(item)
                        }),
                        $el("i.pi.pi-times", {
                            style: {
                                cursor: 'pointer',
                                color: '#ff4444',
                                fontSize: '0.8em'
                            },
                            onclick: async (e) => {
                                e.stopPropagation();
                                try {
                                    const response = await api.fetchApi('/lora_sidebar/update_info', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                            id: lora.id,
                                            field: type,
                                            value: items.filter(i => i !== item)
                                        })
                                    });
    
                                    if (response.ok) {
                                        items.splice(items.indexOf(item), 1);
                                        updateSection(items);
                                        this.showToast("success", "Updated", `Removed ${isTrainedWords ? 'trigger word' : 'tag'}`);
                                    }
                                } catch (error) {
                                    console.error("Error updating:", error);
                                    this.showToast("error", "Update Failed", "Failed to update");
                                }
                            }
                        })
                    ]);
                    itemsContainer.appendChild(pillContainer);
                });
    
                editContainer.appendChild(itemsContainer);
                container.appendChild(editContainer);
            } else {
                // Display mode
                const itemsContainer = $el("div.word-pills", 
                    items.length > 0 
                        ? items.map(item => 
                            $el("span.word-pill", { 
                                textContent: item,
                                onclick: () => this.copyToClipboard(item)
                            })
                        )
                        : [$el("span", { textContent: "None", className: "no-tags" })]
                );
                container.appendChild(itemsContainer);

                // Only add the Copy All button for trained words section when there are items
                if (type === 'trained_words' && items.length > 0) {
                    const copyAllButton = $el("button.copy-all-button", {
                        textContent: "Copy All",
                        onclick: () => this.copyToClipboard(items.join(", "))
                    });
                    container.appendChild(copyAllButton);
                }
            }
        };
    
        updateSection(items);
        return container;
    }

    async handleLastGeneratedImage(lora) {
        try {
            // Get the latest temp image info
            const response = await fetch('/lora_sidebar/latest_temp_image');
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.message || 'Failed to get latest generated image');
            }
            
            const imageInfo = await response.json();
            
            // Use the existing upload endpoint with the URL
            const uploadResponse = await fetch('/lora_sidebar/upload_images', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    lora_id: lora.id,
                    urls: [imageInfo.url]  // Using the existing URL format
                })
            });
    
            const result = await uploadResponse.json();
            
            if (result.status === 'success') {
                // Update the lora object with new images
                lora.images = lora.images || [];
                lora.images.push(...result.images);
                
                // Refresh the info popup if it's open
                const infoPopup = document.querySelector('.model-info-popup');
                if (infoPopup) {
                    this.showLoraInfo(lora, null);
                }
                
                this.showToast("success", "Image Added", "Last generated image added successfully");
                return true;
            } else {
                throw new Error(result.message || 'Failed to add image');
            }
        } catch (error) {
            debug.log("Error adding last generated image:", error);
            this.showToast("error", "Add Failed", error.message || "No generated images found");
            return false;
        }
    }

    async showFileDetails(lora) {
        this.removePreviousPopups();

        try {
            const fullPath = lora.path || "";
            const directory = fullPath.substring(0, fullPath.lastIndexOf('\\'));
            const filename = fullPath.substring(fullPath.lastIndexOf('\\') + 1);
            const response = await api.fetchApi(`/lora_sidebar/file_details/${lora.id}`);
            const result = await response.json();
    
            // Helper function to create a label with buttons
            const createLabelWithCopy = (labelText, contentToCopy, canOpenFolder = false) => {
                return $el("p.file-location-label", [
                    $el("span", { textContent: labelText }),
                    $el("div.action-buttons", {
                        style: {
                            marginLeft: "8px",
                            display: "inline-flex",
                            gap: "8px"
                        }
                    }, [
                        // Existing copy button
                        $el("i.pi.pi-clipboard", {
                            style: {
                                cursor: "pointer",
                                fontSize: "0.9em",
                                opacity: "0.7"
                            },
                            onclick: (e) => {
                                e.stopPropagation();
                                this.copyToClipboard(contentToCopy);
                            }
                        }),
                        // New folder open button - only show for directory paths
                        canOpenFolder && $el("i.pi.pi-folder-open", {
                            style: {
                                cursor: "pointer",
                                fontSize: "0.9em",
                                opacity: "0.7"
                            },
                            title: "Open in file browser",
                            onclick: async (e) => {
                                e.stopPropagation();
                                try {
                                    const response = await fetch('/lora_sidebar/open_folder', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ path: contentToCopy })
                                    });
                                    
                                    if (!response.ok) {
                                        // Fallback to copy if opening fails
                                        this.copyToClipboard(contentToCopy);
                                        this.showToast("info", "Copied Instead", 
                                            "Couldn't open folder, path copied to clipboard instead.");
                                    }
                                } catch (error) {
                                    // Fallback to copy on error
                                    this.copyToClipboard(contentToCopy);
                                    this.showToast("info", "Copied Instead", 
                                        "Couldn't open folder, path copied to clipboard instead.");
                                }
                            }
                        })
                    ].filter(Boolean))  // Remove null items (when canOpenFolder is false)
                ]);
            };
        
            const detailsPopup = $el("div.confirm-delete-popup", {
                onclick: (e) => e.stopPropagation()
            }, [
                $el("h3", {
                    textContent: "LoRA File Details",
                    style: {
                        margin: "0 0 15px 0"
                    }
                }),
                // Source Location
                createLabelWithCopy("Source Location:", directory, true),
                $el("p", {
                    className: "file-location",
                    textContent: directory || "Path not available"
                }),
                
                // Source File
                createLabelWithCopy("Source File:", filename),
                $el("p", {
                    className: "file-location",
                    textContent: filename || "Filename not available"
                }),
                
                // Managed Location
                createLabelWithCopy("Managed Location:", result.managed_dir, true),
                $el("p", {
                    className: "file-location",
                    textContent: result.managed_dir || "Path not available"
                }),
        
                $el("div.confirm-buttons", [
                    $el("button", {
                        textContent: "Close",
                        onclick: (e) => {
                            e.stopPropagation();
                            document.body.removeChild(detailsPopup);
                        }
                    })
                ])
            ]);
        
            document.body.appendChild(detailsPopup);

            const handleOutsideClick = (e) => {
                if (!detailsPopup.contains(e.target)) {
                    e.stopPropagation();
                    // Check if popup still exists and is a child of document.body
                    if (document.body.contains(detailsPopup)) {
                        document.body.removeChild(detailsPopup);
                    }
                    document.removeEventListener('click', handleOutsideClick);
                }
            };

            // Small delay to prevent immediate closing
            setTimeout(() => {
                document.addEventListener('click', handleOutsideClick);
            }, 0);

        } catch (error) {
            console.error("Error fetching file details:", error);
            this.showToast("error", "Error", "Failed to fetch file details");
        }
    }

    confirmDeleteLora(lora) {
        this.removePreviousPopups();

        const confirmPopup = $el("div.confirm-delete-popup", {
            onclick: (e) => e.stopPropagation()
        }, [
            $el("p", {
                textContent: "Are you sure you want to delete the sidebar data for this LoRA? This won't remove the LoRA or local data from your hard drive."
            }),
            $el("div.confirm-buttons", [
                $el("button", {
                    textContent: "Cancel",
                    onclick: (e) => {
                        e.stopPropagation();
                        document.body.removeChild(confirmPopup);
                    }
                }),
                $el("button", {
                    textContent: "Delete",
                    onclick: (e) => {
                        e.stopPropagation();
                        this.deleteLora(lora);
                    }
                })
            ])
        ]);
        document.body.appendChild(confirmPopup);

        const handleOutsideClick = (e) => {
            if (!confirmPopup.contains(e.target)) {
                e.stopPropagation();
                // Check if popup still exists and is a child of document.body
                if (document.body.contains(confirmPopup)) {
                    document.body.removeChild(confirmPopup);
                }
                document.removeEventListener('click', handleOutsideClick);
            }
        };

        // Small delay to prevent immediate closing
        setTimeout(() => {
            document.addEventListener('click', handleOutsideClick);
        }, 0);
    }

    createUploadPopup(lora) {
        // Remove any existing popups
        this.removePreviousPopups();
    
        // Create file input element (hidden)
        const fileInput = $el("input", {
            type: "file",
            multiple: true,
            accept: "image/*",
            style: { display: "none" },
            onchange: (e) => {
                const files = Array.from(e.target.files);
                if (files.length > 0) {
                    filePathInput.value = files.map(f => f.name).join(", ");
                    // Clear the error message if it exists
                    const errorMsg = popup.querySelector('.error-message');
                    if (errorMsg) errorMsg.remove();
                }
            }
        });
    
        // Create text input for file path
        const filePathInput = $el("input", {
            type: "text",
            placeholder: "Select images, enter file path, or paste image URL...",
            className: "file-path-input",
            style: {
                width: "100%",
                padding: "8px",
                marginBottom: "15px",
                backgroundColor: "#2a2a2a",
                border: "1px solid #444",
                borderRadius: "4px",
                color: "inherit"
            }
        });
    
        // Create the popup
        const popup = $el("div.confirm-delete-popup", {
            onclick: (e) => e.stopPropagation(),
            style: {
                width: "400px",
                padding: "20px"
            }
        }, [
            $el("h3", { 
                textContent: "Add Images",
                style: { 
                    marginTop: "0",
                    marginBottom: "15px",
                    textAlign: "center" 
                }
            }),
            $el("p", { 
                textContent: "Select one or more local images to add to the carousel. You can also paste an image URL.",
                style: { 
                    marginBottom: "15px",
                    textAlign: "center",
                    color: "#999",
                    fontSize: "0.9em"
                }
            }),
            filePathInput,
            // Action buttons container
            $el("div.action-buttons", {
                style: {
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: "10px",
                    marginBottom: "20px"
                }
            }, [
                $el("button", {
                    textContent: "Browse Files...",
                    className: "confirm-button",
                    style: {
                        minWidth: "200px"
                    },
                    onclick: () => fileInput.click()
                }),
                $el("button", {
                    className: "confirm-button",
                    style: {
                        minWidth: "200px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: "8px",
                        height: "32px",  // Match confirm button height
                        borderRadius: "6px",  // More rounded
                    },
                    onclick: async (e) => {
                        e.stopPropagation();
                        const button = e.target.closest('button');  // Get the button element even if icon was clicked
                        const originalHtml = button.innerHTML;
                        
                        button.disabled = true;
                        button.textContent = "Adding...";
                        
                        try {
                            const success = await this.handleLastGeneratedImage(lora);
                            if (success) {
                                popup.remove();
                            }
                        } finally {
                            button.disabled = false;
                            button.innerHTML = originalHtml;
                        }
                    }
                }, [
                    $el("i.pi.pi-microchip-ai", {
                        style: {
                            fontSize: "16px"  // Adjust icon size as needed
                        }
                    }),
                    $el("span", { textContent: "Add Last Generated Image" })
                ])
            ]),
            // Confirm/Cancel buttons at bottom
            $el("div.confirm-buttons", {
                style: {
                    display: "flex",
                    justifyContent: "center",
                    gap: "10px"
                }
            }, [
                $el("button", {
                    textContent: "Cancel",
                    onclick: () => popup.remove(),
                    style: {
                        minWidth: "100px" // Consistent width for bottom buttons
                    }
                }),
                $el("button", {
                    textContent: "Upload",
                    onclick: async () => {
                        const files = fileInput.files;
                        const inputText = filePathInput.value.trim();
    
                        // Check for URLs
                        if (inputText && !files?.length) {
                            const urls = inputText.split(/[\n,]/).map(url => url.trim()).filter(url => url);
                            const validUrls = urls.filter(url => isValidUrl(url));
    
                            if (validUrls.length === 0) {
                                showError("Please enter valid image URLs or select local files");
                                return;
                            }
    
                            try {
                                const response = await fetch('/lora_sidebar/upload_images', {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json'
                                    },
                                    body: JSON.stringify({
                                        lora_id: lora.id,
                                        urls: validUrls
                                    })
                                });
    
                                const result = await response.json();
                                
                                if (result.status === 'success') {
                                    handleUploadSuccess(result);
                                } else {
                                    throw new Error(result.message || 'Upload failed');
                                }
                            } catch (error) {
                                console.error("Error uploading URLs:", error);
                                this.showToast("error", "Upload Failed", error.message);
                            } finally {
                                popup.remove();
                            }
                            return;
                        }
    
                        // Handle local files
                        if (!files || files.length === 0) {
                            showError("Please select at least one image or enter valid URLs");
                            return;
                        }
    
                        const formData = new FormData();
                        formData.append('lora_id', lora.id);
                        
                        for (const file of files) {
                            formData.append('files[]', file);
                        }
    
                        try {
                            const response = await fetch('/lora_sidebar/upload_images', {
                                method: 'POST',
                                body: formData
                            });
    
                            const result = await response.json();
                            
                            if (result.status === 'success') {
                                handleUploadSuccess(result);
                            } else {
                                throw new Error(result.message || 'Upload failed');
                            }
                        } catch (error) {
                            console.error("Error uploading files:", error);
                            this.showToast("error", "Upload Failed", error.message);
                        } finally {
                            popup.remove();
                        }
                    },
                    style: {
                        minWidth: "100px"
                    }
                })
            ])
        ]);
    
        const showError = (message) => {
            // Remove existing error message if any
            const existingError = popup.querySelector('.error-message');
            if (existingError) existingError.remove();
    
            // Add new error message
            const errorMsg = $el("p.error-message", {
                textContent: message,
                style: {
                    color: "#ff4444",
                    marginTop: "5px",
                    fontSize: "0.9em",
                    textAlign: "center"
                }
            });
            popup.insertBefore(errorMsg, popup.querySelector('.confirm-buttons'));
        };
    
        const handleUploadSuccess = (result) => {
            lora.images = lora.images || [];
            lora.images.push(...result.images);
            
            const infoPopup = document.querySelector('.model-info-popup');
            if (infoPopup) {
                this.showLoraInfo(lora, null);
            }
            
            this.showToast("success", "Upload Complete", result.message);
        };

        // outside click handler
        const handleOutsideClick = (e) => {
            if (!popup.contains(e.target)) {
                e.stopPropagation();
                if (document.body.contains(popup)) {
                    document.body.removeChild(popup);
                }
                document.removeEventListener('click', handleOutsideClick);
            }
        };
    
        document.body.appendChild(popup);

        // Small delay to prevent immediate closing
        setTimeout(() => {
            document.addEventListener('click', handleOutsideClick);
        }, 0);

        fileInput.addEventListener('change', () => {
            const files = fileInput.files;
            if (files.length > 0) {
                filePathInput.value = Array.from(files).map(f => f.name).join(", ");
            }
        });
    }

    async deleteLora(lora) {
        try {
            const response = await api.fetchApi('/lora_sidebar/delete_lora', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: lora.id })
            });

            if (response.ok) {
                // Remove lora from data arrays
                this.loraData = this.loraData.filter(l => l.id !== lora.id);
                this.filteredData = this.filteredData.filter(l => l.id !== lora.id);

                // Close popups
                if (this.currentPopup) {
                    this.currentPopup.remove();
                    this.currentPopup = null;
                }
                document.querySelector('.confirm-delete-popup').remove();

                // Redraw sidebar
                this.renderLoraGallery();

                this.showToast("success", "LoRA Deleted", `${lora.name} has been deleted successfully.`);
            } else {
                throw new Error('Failed to delete LoRA');
            }
        } catch (error) {
            console.error("Error deleting LoRA:", error);
            this.showToast("error", "Deletion Failed", `Failed to delete ${lora.name}.`);
        }
    }

    handleFirstOpen() {
        if (this.isFirstOpen) {
            this.isFirstOpen = false;
            this.isNewSession = this.checkNewSession();
            // Re-initialize state if it's a new session
            if (this.isNewSession) {
                this.state = this.getDefaultState();
            }
        }
    }

    // Shared function for any option that requires resorting
    async refreshSortedData() {
        try {
            // Clear current data
            this.loraData = [];
            this.filteredData = [];

            // Clear all pending data before clearing HTML
            const categories = this.galleryContainer.querySelectorAll('.lora-category');
            categories.forEach(category => {
                const content = category.querySelector('.lora-items-container');
                if (content) {
                    delete content.dataset.pendingLorasData;
                }
            });

            this.galleryContainer.innerHTML = '';

            // Show loading state
            this.loadingOverlay.style.display = "flex";

            // Use existing loader!
            await this.loadLoraData(0, this.batchSize);
            
            // Re-render with new sorted data
            this.handleSearch(this.state.searchTerm || '');
        
        } catch (error) {
            console.error("Error refreshing sorted data:", error);
            this.showToast("error", "Sort Failed", "Failed to update sort order. Please try refreshing the page.");
        } finally {
            setTimeout(() => {
                this.loadingOverlay.style.display = "none";
            }, 2000);  // give the UI some time to update
        }
    }

    ///////

    updateShowNSFW(newVal) {
        this.showNSFW = newVal;
        if (!this.isFirstOpen) {
        this.handleSearch(this.state.searchTerm || '');  // Re-filter using current search term
        }
    }

    updateNSFWlevel(newVal) {
        this.nsfwThreshold = newVal;
        if (!this.isFirstOpen) {
        this.handleSearch(this.state.searchTerm || '');
        }
    }
    
    updateSavedModelFilter(newVal) {
        this.savedModelFilter = newVal;
        this.modelFilter = newVal;  // Update the current model filter
        if (!this.isFirstOpen) {
        this.handleSearch(this.state.searchTerm || '');
        }
    }

    updateSortOrder(newVal) {
        this.sortModels = newVal;
        if (!this.isFirstOpen) {
        this.refreshSortedData();
        }
    }

    updateLoraSize(newVal) {
        this.savedElementSize = newVal;
        this.elementSize = newVal;
        if (!this.isFirstOpen) {
        this.update();
        }
    }

    updateTags(newVal) {
        this.CUSTOM_TAGS = newVal.split(',').map(tag => tag.trim().toLowerCase());
        if (this.tagSource === 'Custom' && !this.isFirstOpen) {
            this.refreshSortedData();
        }
    }

    updateTagSource(newVal) {
        this.tagSource = newVal;
        if (!this.isFirstOpen) {
            this.refreshSortedData();
        }
    }

    updateSmartInfo(newVal) {
        this.smartInfo = newVal;

    }

    updateSortMethod(newVal) {
        this.SorthMethod = newVal;
        if (!this.isFirstOpen) {
            this.refreshSortedData();
        }
    }

    updateCatNew(newVal) {
        this.CatNew = newVal;
    }

    updateNSFWfolder(newVal) {
        this.nsfwFolder = newVal;
        if (!this.isFirstOpen) {
            this.refreshSortedData();
        }
    }

    updateNSFWstring(newVal) {
        this.nsfwString = newVal;
        if (!this.isFirstOpen && this.nsfwFolder) {
            this.debounce(this.refreshSortedData(),2500);
        }
    }

    updateCategoryState(newVal) {
        this.defaultCatState = newVal === "Expanded";
    }

    updateInfoPersist(newVal) {
        this.infoPersist = newVal;
    }

    updateBatchSize(newVal) {
        this.batchSize = newVal;
    }

    updateFavState(newVal) {
        this.favState = newVal;
        this.FavOpen = newVal;
    }

    updateA1111Style(newVal) {
        this.a1111Style = newVal;
    }

    updateUseRG3(newVal) {
        this.UseRG3 = newVal;
    }

    updateSmartEnabled(newVal) {
        if (newVal) {
            this.showToast("success", "LoRA Smart Info Enabled", 'Automatic LoRA Info & Previews are ON 💪');
        } else {
            this.showToast("warn", "LoRA Smart Info Disabled", 'Automatic LoRA Info & Previews are OFF 😢');
        }
    } 


    ////////

    async update() {
        debug.log("LoRA Sidebar update called");

        if (this.isFirstOpen) {
            // Do nothing if the sidebar hasn't been opened yet
            return;
        }
        
        if (this.isNewSession) {

            const {
                unprocessedCount,
                newCount,
                movedCount,
                missingCount,
                localMetadata,
                remoteMetadata
            } = await this.checkUnprocessedLoras();

            debug.log(`Unprocessed LoRAs: ${unprocessedCount}`);
            if (unprocessedCount > 0) {
                const shouldProcess = await this.showUnprocessedLorasPopup({
                    new: newCount,
                    moved: movedCount,
                    missing: missingCount,
                    local: localMetadata,
                    remote: remoteMetadata
                });
                if (shouldProcess) {
                    await this.processLoras();
                }
            }

            this.loadingOverlay.style.display = "flex";
            await this.loadLoraData();
            this.isNewSession = false;
            this.saveState(); // Save the state after initial load

            // Hide loading overlay
            this.loadingOverlay.style.display = "none";

        }

        const initialCount = this.state.totalLoaded || 500;
        this.handleSearch(this.state.searchTerm || '');
    }

}

app.registerExtension({
    name: "comfy.lora.sidebar",
    async setup() {
        console.log("%c[LoRA Sidebar]", "color: #00ff00", "Extension setup starting");
        
        // Wait for stores to be available
        await app.storesReady;
        console.log("%c[LoRA Sidebar]", "color: #00ff00", "Stores ready");
        
        const loraSidebar = new LoraSidebar(app);
        app.loraSidebar = loraSidebar;

        // Add smart info feature after sidebar is created
        console.log("%c[LoRA Sidebar]", "color: #00ff00", "Creating SmartInfo instance");
        loraSidebar.smartInfo = new LoraSmartInfo(loraSidebar);

        app.extensionManager.registerSidebarTab({
            id: "lora.sidebar",
            icon: "pi pi-address-book",
            title: "LoRA Sidebar",
            tooltip: "LoRA Sidebar",
            type: "custom",
            render: (el) => {
                el.appendChild(loraSidebar.element);
                if (loraSidebar.isFirstOpen) {
                    loraSidebar.isFirstOpen = false;
                    loraSidebar.isNewSession = loraSidebar.checkNewSession();
                }
                loraSidebar.update().then(() => {
                    // After update completes, restore scroll position
                    const sidebarContentContainer = document.querySelector('.sidebar-content-container');
                    if (sidebarContentContainer && loraSidebar.state.scrollPosition) {
                        sidebarContentContainer.scrollTop = loraSidebar.state.scrollPosition;
                    }
                });
                loraSidebar.setupScrollHandler();
                loraSidebar.setupCanvasDropHandling();
            },
        });
    },
    settings: [
        {
            id: "LoRA Sidebar.General.showModels",
            name: "Base Models to Show",
            category: ["LoRA Sidebar", "General", "Model Filter"],
            type: "combo",
            options: ["All", "Pony", "Flux", "SD 3.5", "Illustrious", "SDXL", "SD1.5", "Other"],
            // can use this format to separate text from actual values { text: "My first option", value: "first" }
            defaultValue: "All",
            attrs: {
                editable: false,
                filter: true,
            },
            onChange: (newVal, oldVal) => {
                if (app.loraSidebar && oldVal !== undefined) {
                    app.loraSidebar.updateSavedModelFilter(newVal);
                }
            },
        },
        {
            id: "LoRA Sidebar.General.batchSize",
            name: "LoRA Loading Batch Size",
            tooltip : 'How many LoRAs we load at once, for best performance with large collections set to just over 50% of your total amount. (i.e. for ~9600 set it to 5000)',
            category: ["LoRA Sidebar", "General", "Batch Size"],
            type: "slider",
            defaultValue: 1000,
            attrs: { 
                min: 250,
                max: 15000,
                step: 250,
            },
            onChange: (newVal, oldVal) => {
                if (app.loraSidebar && oldVal !== undefined) {
                    app.loraSidebar.updateBatchSize(newVal);
                }
            },
        },
        {
            id: "LoRA Sidebar.General.catState",
            name: `Default Category State`,
            tooltip : 'Minimized is much faster if you have a LOT (1000s) of LoRAs',
            category: ["LoRA Sidebar", "General", "Category State"],
            type: 'combo',
            options: ['Expanded', 'Minimized'],
            defaultValue: 'Expanded',
            onChange: (newVal, oldVal) => {
                if (app.loraSidebar && oldVal !== undefined) {
                    app.loraSidebar.updateCategoryState(newVal);
                }
            },
        },
        {
            id: "LoRA Sidebar.General.favState",
            name: `Expand Favorites`,
            tooltip : 'Default Favorites to expanded regardless of other settings (Does not override manual toggle)',
            category: ["LoRA Sidebar", "General", "Favorites"],
            type: "boolean",
            defaultValue: true,
            onChange: (newVal, oldVal) => {
                if (app.loraSidebar && oldVal !== undefined) {
                    app.loraSidebar.updateFavState(newVal);
                }
            },
        },
        {
            id: "LoRA Sidebar.General.infoPersist",
            name: "Keep LoRA Info Open",
            tooltip : 'Keeps the LoRA Info Window Open Unless Manually Closed',
            category: ["LoRA Sidebar", "General", "Info Persist"],
            type: "boolean",
            defaultValue: true,
            onChange: (newVal, oldVal) => {
                if (app.loraSidebar && oldVal !== undefined) {
                    app.loraSidebar.updateInfoPersist(newVal);
                }
            },
        },
        {
            id: "LoRA Sidebar.General.a1111Style",
            name: "Use A1111 Lora Prompting",
            tooltip : 'If enabled, will add LoRA and Weight before trained words on drag and drop onto prompt nodes',
            category: ["LoRA Sidebar", "General", "A1111 Style"],
            type: "boolean",
            defaultValue: false,
            onChange: (newVal, oldVal) => {
                if (app.loraSidebar && oldVal !== undefined) {
                    app.loraSidebar.updateA1111Style(newVal);
                }
            },
        },
        {
            id: "LoRA Sidebar.General.useRG3",
            name: "Use rgthree Nodes",
            tooltip : 'Creates a Lora Power Loader Node on drag and drop vs a core node',
            category: ["LoRA Sidebar", "General", "RG3"],
            type: "boolean",
            defaultValue: false,
            onChange: (newVal, oldVal) => {
                if (app.loraSidebar && oldVal !== undefined) {
                    app.loraSidebar.updateUseRG3(newVal);
                }
            },
        },
        {
            id: "LoRA Sidebar.General.catNew",
            name: "Use New Category",
            tooltip : 'Automatically creates special category for LoRAs created 3 days ago or less. (NOT downloaded, but actually created)',
            category: ["LoRA Sidebar", "General", "New Category"],
            type: "boolean",
            defaultValue: false, //TODO DEFAULTED TO FALSE UNTIL I FIX IT
            onChange: (newVal, oldVal) => {
                if (app.loraSidebar && oldVal !== undefined) {
                    app.loraSidebar.updateCatNew(newVal);
                }
            },
        },
        {
            id: "LoRA Sidebar.General.sortMethod",
            name: "Sort LoRAs By",
            tooltip : 'How LoRAs will be sorted, DateNewest will put the most recent files first. (By creation date)',
            category: ["LoRA Sidebar", "General", "Sort Method"],
            type: 'combo',
            options: ['AlphaAsc', 'DateNewest', 'AlphaDesc', 'DateOldest'],
            defaultValue: 'AlphaAsc',
            onChange: (newVal, oldVal) => {
                if (app.loraSidebar && oldVal !== undefined) {
                    app.loraSidebar.updateSortMethod(newVal);
                }
            },
        },
        {
            id: "LoRA Sidebar.General.sortModels",
            name: "Categorize LoRAs By",
            tooltip : 'Subdir uses your directory structure, Tags use model tags, either Custom or from CivitAI. For this change to take effect please refresh the broswer',
            category: ["LoRA Sidebar", "General", "Sort Models"],
            type: 'combo',
            options: ['None', 'Subdir', 'Tags'],
            defaultValue: 'None',
            onChange: (newVal, oldVal) => {
                if (app.loraSidebar && oldVal !== undefined) {
                    app.loraSidebar.updateSortOrder(newVal);
                }
            },
        },
        {
            id: "LoRA Sidebar.General.tagSource",
            name: "Category Tags to Use",
            tooltip : 'Custom will use tags frm the setting above. CivitAI uses the main site categories like Character, Clothing, Poses, etc.',
            category: ["LoRA Sidebar", "General", "Tag Source"],
            type: 'combo',
            options: ['CivitAI', 'Custom'],
            defaultValue: 'CivitAI',
            onChange: (newVal, oldVal) => {
                if (app.loraSidebar && oldVal !== undefined) {
                    app.loraSidebar.updateTagSource(newVal);
                }
            },
        },
        {
            id: "LoRA Sidebar.General.customTags",
            name: "Custom Category Tags",
            tooltip : 'Only used when sort is set to Tags and Tags is set to Custom. A comma seperated list of tags used to create categories, each Lora will only be assigned one category',
            category: ["LoRA Sidebar", "General", "Custom Tags"],
            type: 'text',
            defaultValue: 'character, style, concept, clothing, poses, background',
            onChange: (newVal, oldVal) => {
                if (app.loraSidebar && oldVal !== undefined) {
                    app.loraSidebar.updateTags(newVal);
                }
            },
        },
        {
            id: "LoRA Sidebar.General.thumbnailSize",
            name: "LoRA Display Size",
            tooltip : 'The size of the LoRA thumbnails in the sidebar',
            category: ["LoRA Sidebar", "General", "Thumbnail Size"],
            type: "slider",
            defaultValue: 125,
            attrs: { min: 50, max: 400, step: 25, },
            onChange: (newVal, oldVal) => {
                if (app.loraSidebar && oldVal !== undefined) {
                    app.loraSidebar.updateLoraSize(newVal);
                }
            },
        },
        {
            id: "LoRA Sidebar.General.refreshAll",
            name: "Reprocess All LoRAs on Refresh",
            tooltip: "When enabled, forces all LoRAs to be reprocessed on the next refresh. Automatically disables after processing.",
            category: ["LoRA Sidebar", "General", "Reprocess"],
            type: "boolean",
            defaultValue: false,
            onChange: (() => {
                let toastShown = false;
                return async (newVal, oldVal) => {
                    if (app.loraSidebar && oldVal !== undefined) {
                        try {
                            const response = await api.fetchApi('/lora_sidebar/set_version', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ use_old_version: newVal })
                            });
                            
                            // Only show messages if we're enabling the setting
                            if (newVal && !toastShown) {
                                if (!response.ok) {
                                    throw new Error('Failed to flag LoRAs for Reprocessing');
                                }
                                
                                toastShown = true;
                                app.loraSidebar.showToast(
                                    "info",
                                    "Reprocess Enabled",
                                    "All LoRAs will be reprocessed on next refresh. This setting will automatically disable after processing."
                                );
                                // Reset the flag after a short delay
                                setTimeout(() => { toastShown = false; }, 100);
                            }
                        } catch (error) {
                            // Only show errors when enabling and no toast is shown
                            if (newVal && !toastShown) {
                                console.error("Error updating version:", error);
                                toastShown = true;
                                app.loraSidebar.showToast(
                                    "error",
                                    "Update Failed",
                                    "Failed to update reprocess setting. Please try again."
                                );
                                // Reset the flag after a short delay
                                setTimeout(() => { toastShown = false; }, 100);
                            }
                        }
                    }
                };
            })(),
        },
        {
            id: "LoRA Sidebar.Smart Info.showTrained",
            name: "Trained Words on Canvas Previews",
            tooltip: "Display trained words under Canvas Preview images",
            category: ["LoRA Sidebar", "Smart Info", "Trained Words"],
            type: "boolean",
            defaultValue: true,
            onChange: (newVal, oldVal) => {
                if (app.loraSidebar && oldVal !== undefined) {
                    app.loraSidebar.smartInfo.updateShowTrained(newVal);
                }
            },
        },
        {
            id: "LoRA Sidebar.Smart Info.showSidebar",
            name: "LoRA Info in Sidebar",
            tooltip: "Automatically disaply LoRA Info when Sidebar is open",
            category: ["LoRA Sidebar", "Smart Info", "Sidebar Info"],
            type: "boolean",
            defaultValue: true,
            onChange: (newVal, oldVal) => {
                if (app.loraSidebar && oldVal !== undefined) {
                    app.loraSidebar.smartInfo.updateShowSidebar(newVal);
                }
            },
        },
        {
            id: "LoRA Sidebar.Smart Info.showCanvas",
            name: "LoRA Previews on Canvas",
            tooltip: "Display LoRA Previews on the Canvas",
            category: ["LoRA Sidebar", "Smart Info", "Canvas Preview"],
            type: "boolean",
            defaultValue: true,
            onChange: (newVal, oldVal) => {
                if (app.loraSidebar && oldVal !== undefined) {
                    app.loraSidebar.smartInfo.updateShowOnCanvas(newVal);
                }
            },
        },
        {
            id: "LoRA Sidebar.Smart Info.showMenu",
            name: "LoRA Previews on Menus",
            tooltip: "Display LoRA preview images while using selection menus",
            category: ["LoRA Sidebar", "Smart Info", "Menu Preview"],
            type: "boolean",
            defaultValue: true,
            onChange: (newVal, oldVal) => {
                if (app.loraSidebar && oldVal !== undefined) {
                    app.loraSidebar.smartInfo.updateShowOnMenu(newVal);
                }
            },
        },
        {
            id: "LoRA Sidebar.Smart Info.zoomLevel",
            name: "Zoom Cutoff for Previews (in %)",
            tooltip: "Sets the zoom level where we turn off LoRA canvas previews",
            category: ["LoRA Sidebar", "Smart Info", "Zoom Level"],
            type: "slider",
            defaultValue: 50,
            attrs: { min: 1, max: 100, step: 5, },
            onChange: (newVal, oldVal) => {
                if (app.loraSidebar && oldVal !== undefined) {
                    app.loraSidebar.smartInfo.updateZoomLevel(newVal);
                    debug.log("Updated Zoom:", newVal);
                }
            },
        },
        {
            id: "LoRA Sidebar.Smart Info.smartEnabled",
            name: "Smart Info Feature",
            tooltip: "Automagically show LoRA previews and info when working with LoRA nodes. (Disabling this will automatically Disable ALL other Smart Info features)",
            category: ["LoRA Sidebar", "Smart Info", "Smart Enabled"],
            type: "boolean",
            defaultValue: true,
            onChange: (newVal, oldVal) => {
                let lastProcessed = { newVal: undefined, oldVal: undefined };
                // Check if this change has already been processed
                if (newVal === lastProcessed.newVal && oldVal === lastProcessed.oldVal) {
                    // This change has already been processed, skip
                    debug.log("COMFYUI FIX YOUR SHIT - Duplicate onChange call detected, skipping.");
                    return;
                }
        
                // Update last processed values
                lastProcessed.newVal = newVal;
                lastProcessed.oldVal = oldVal;
        
                debug.log("Settings onChange called with:", { newVal, oldVal });
        
                if (app.loraSidebar && oldVal !== undefined) {
                    app.loraSidebar.smartInfo.updateSettings(newVal);
                    app.loraSidebar.updateSmartEnabled(newVal);
                }
            },
        },
        {
            id: "LoRA Sidebar.NSFW.folderString",
            name: "NSFW Folder Name",
            tooltip : 'Name of the folder(s) to use for NSFW folder checks.',
            category: ["LoRA Sidebar", "NSFW", "NSFW Folder String"],
            type: 'text',
            defaultValue: 'NSFW',
            onChange: (newVal, oldVal) => {
                if (app.loraSidebar && oldVal !== undefined) {
                    app.loraSidebar.updateNSFWstring(newVal);
                }
            },
        },
        {
            id: "LoRA Sidebar.NSFW.nsfwFolder",
            name: "Use NSFW Folders",
            tooltip : 'Flags LoRAs as NSFW if they are in a folder containing "NSFW" (Ignores saved NSFW Flags).',
            category: ["LoRA Sidebar", "NSFW", "NSFW Folder"],
            type: "boolean",
            defaultValue: true,
            onChange: (newVal, oldVal) => {
                if (app.loraSidebar && oldVal !== undefined) {
                    app.loraSidebar.updateNSFWfolder(newVal);
                }
            },
        },
        {
            id: "LoRA Sidebar.NSFW.nsfwLevel",
            name: "Max Allowed NSFW Level (50 Allows All Content)",
            tooltip : 'Calculates how NSFW a LoRA is using the CivitAI NSFW score of sample images',
            category: ["LoRA Sidebar", "NSFW", "NSFW Level"],
            type: "slider",
            defaultValue: 25,
            attrs: { min: 1, max: 50, step: 1, },
            onChange: (newVal, oldVal) => {
                if (app.loraSidebar && oldVal !== undefined) {
                    app.loraSidebar.updateNSFWlevel(newVal);
                }
            },
        },
        {
            id: "LoRA Sidebar.NSFW.hideNSFW",
            name: "Show NSFW LoRAs",
            tooltip : 'Uses the CivitAI NSFW flags which are not very reliable',
            category: ["LoRA Sidebar", "NSFW", "Show NSFW"],
            type: "boolean",
            defaultValue: true,
            onChange: (newVal, oldVal) => {
                if (app.loraSidebar && oldVal !== undefined) {
                    app.loraSidebar.updateShowNSFW(newVal);
                }
            },
        },
    ],
});
