import { app } from "../../scripts/app.js";
const stores = app.getAppStores?.() || {};

var debug = {
    enabled: true,
    log: function(...args) {
        if (this.enabled) {
            console.log(...args);
        }
    }
};

class LoraSmartInfo {
    constructor(loraSidebar) {
        this.sidebar = loraSidebar;
        this.app = loraSidebar.app;
        this.canvasStore = stores.canvasStore;
        this.settingStore = stores.settingStore;

        this.enabled = app.extensionManager.setting.get('LoRA Sidebar.Smart Info.smartEnabled', true);
        this.showSidebar = app.extensionManager.setting.get('LoRA Sidebar.Smart Info.showSidebar', true);
        this.showTrained = app.extensionManager.setting.get('LoRA Sidebar.Smart Info.showTrained', true);
        this.zoomLevel = app.extensionManager.setting.get('LoRA Sidebar.Smart Info.zoomLevel', 50);
        this.showMenu = app.extensionManager.setting.get('LoRA Sidebar.Smart Info.showMenu', true);
        this.showCanvas = app.extensionManager.setting.get('LoRA Sidebar.Smart Info.showCanvas', true);
        this.loraData = loraSidebar.loraData;
        this.currentHoverTimer = null;
        this.hoverDelay = 500;
        this.lastWidget = null;
        this.lastNode = null;
        this.lastLoraValue = null;
        this.hasShownSidebarWarning = false;
        this.menuObserver = null;
        this.menuDebounceTimer = null;
        this.menuDebounceDelay = 50;
        this.comfyClickHandler = null;  // handler reference
        this.listenerActive = false;  // Track listener state
        this.graphMonitorInitialized = false;
        this.menuObserverInitialized = false;
        this.activePreviewCleanup = null; // Add this property to track active preview

        if (this.enabled) {
            this.sidebar.showToast(
                "info", 
                "Smart LoRA Info Active",
                "Automatic LoRA Previews & Info will be displayed. (Customize this in LoRA Sidebar Settings)"
            );
            if (this.app.graph) {
                this.setupGraphMonitor();
                this.graphMonitorInitialized = true;
                debug.log("Graph monitor initialized");
            }
            
            // Set up observer for menu entries
            this.setupMenuObserver();
            this.menuObserverInitialized = true;
            debug.log("Menu observer initialized");

            // Initialize all features through updateSettings instead of calling directly
            this.updateSettings(this.enabled);
            debug.log("Selection listeners initialized");
        } else {
            // If not enabled, just call updateSettings with false
            this.updateSettings(false);
        }
    }

    updateSettings(newEnabled) {
        this.enabled = newEnabled;
        if (!this.enabled) {
            // If master toggle is off, disable all runtime features
            this.showSidebar = false;
            this.showTrained = false;
            this.showMenu = false;
            this.showCanvas = false;
            this.removeComfyListeners();  // Clean up listeners
            debug.log("Disabled all features");
        } else {
            // If enabled, restore user settings
            this.showSidebar = app.extensionManager.setting.get('LoRA Sidebar.Smart Info.showSidebar', true);
            this.showTrained = app.extensionManager.setting.get('LoRA Sidebar.Smart Info.showTrained', true);
            this.showMenu = app.extensionManager.setting.get('LoRA Sidebar.Smart Info.showMenu', true);
            this.showCanvas = app.extensionManager.setting.get('LoRA Sidebar.Smart Info.showCanvas', true);
            if (this.app.graph && !this.graphMonitorInitialized) {
                this.setupGraphMonitor();
                this.graphMonitorInitialized = true;
            }
            
            // Set up observer for menu entries
            if (!this.menuObserverInitialized) {
                this.setupMenuObserver();
                this.menuObserverInitialized = true;
            }
            
            // Add this line to ensure listeners are set up when enabled
            this.setupComfyListeners();
            
            debug.log("Enabled all features");
        }
     }

    isSidebarOpen() {
        // Skip check if feature is disabled
        if (!this.showSidebar) return false;

        const sidebarContent = document.querySelector('.lora-sidebar-content');
        if (!sidebarContent) return false;

        const style = window.getComputedStyle(sidebarContent);
        const isVisible = style.display !== 'none' && 
                         style.visibility !== 'hidden' && 
                         style.opacity !== '0';

        // Also check if our data is loaded
        const hasData = this.sidebar?.loraData?.length > 0;

        return isVisible && hasData;
    }

    setupComfyListeners() {
        debug.log("TEST: setupComfyListeners called");

        const canvas = app.canvas;
        if (!canvas) {
            debug.log("TEST: Canvas not available through app");
            return;
        }

        // Clean up existing listener if any
        if (this.listenerActive) {
            debug.log("TEST: Removing existing listener");
            canvas.onSelectionChange = canvas._original_onSelectionChange || null;
        }

        debug.log("TEST: Canvas found through app, setting up listener");
        
        // Store original handler
        canvas._original_onSelectionChange = canvas.onSelectionChange;

        canvas.onSelectionChange = (selectedNodes) => {
            // Call original handler if it exists
            if (canvas._original_onSelectionChange) {
                canvas._original_onSelectionChange(selectedNodes);
            }

            debug.log("TEST: Selection changed!", selectedNodes);
            
            // Clear any existing preview
            if (this.lastNodePreviewClear) {
                this.lastNodePreviewClear();
                this.lastNodePreviewClear = null;
            }

            // Handle object format of selected nodes
            const nodes = [];
            if (selectedNodes) {
                if (Array.isArray(selectedNodes)) {
                    nodes.push(...selectedNodes);
                } else if (typeof selectedNodes === 'object') {
                    nodes.push(...Object.values(selectedNodes));
                } else {
                    nodes.push(selectedNodes);
                }
            }

            nodes.forEach(node => {
                if (!node) return;

                // Early exit if not a node type we care about
                if (node.type !== "LoraLoader" && 
                    node.type !== "Power Lora Loader (rgthree)" && 
                    node.type !== "Power Prompt (rgthree)") {
                    return;
                }

                debug.log("TEST: Selected node:", node.title, node.type, node);
                debug.log("TEST: Node widgets:", node.widgets); // Add this debug line
                
                let widget;

                // Handle the common cases first
                if (node.type === "LoraLoader") {
                    widget = node.widgets?.find(w => w.name === "lora_name");
                }
                else if (node.type === "Power Lora Loader (rgthree)") {
                    // Modified widget search for Power Lora
                    widget = node.widgets?.find(w => {
                        // Check if the widget has a value that might contain lora data
                        const hasLoraData = w.value && 
                            typeof w.value === 'object' &&
                            (w.value.lora || 
                                (Array.isArray(w.value) && w.value.length > 0));
                        
                        debug.log(`TEST: Checking widget:`, w.name, hasLoraData);
                        debug.log("TEST: Power Lora widget found:", widget);
                        return hasLoraData;
                    });
                }
                // Finally check Power Prompt
                else if (node.type === "Power Prompt (rgthree)") {
                    widget = node.widgets?.find(w => w.name === "prompt");
                    if (widget?.value) {
                        const promptText = widget.value || widget.getValue?.() || '';
                        const loraMatch = promptText.match(/<lora:([^:]+):/);
                        if (loraMatch) {
                            widget = {
                                value: loraMatch[1],
                                name: "lora_name"
                            };
                        }
                    }
                }
                    
                if (widget) {
                    const loraName = this.extractLoraName(widget, node);
                    debug.log("TEST: LoRA name found:", loraName);
                    if (loraName) {
                        if (this.isSidebarOpen()) {
                            this.showLoraInfo(loraName);
                        } else {
                            // Get node position in screen coordinates
                            const rect = node.getBounding();
                            const scale = canvas.ds.scale;
                            const offset = canvas.ds.offset;
                            
                            // Calculate screen position
                            const x = (rect[0] + offset[0]) * scale + canvas.canvas.offsetLeft;
                            const y = (rect[1] + offset[1]) * scale + canvas.canvas.offsetTop;
                            
                            // Show preview next to node - PASS THE NODE!
                            this.showPreviewOnCanvas(loraName, x, y, node)
                                .then(cleanupFunc => {
                                    if (cleanupFunc) {
                                        this.lastNodePreviewClear = cleanupFunc;
                                    }
                                });
                        }
                    }
                }
            });
        };
        
        this.listenerActive = true;
        debug.log("TEST: Listener setup complete");
    }
    
    removeComfyListeners() {
        if (this.listenerActive && this.canvasStore?.canvas) {
            this.canvasStore.canvas.removeEventListener('click', this.comfyClickHandler);
            this.comfyClickHandler = null;
            this.listenerActive = false;
        }
    }

    isEnabled() {
        return this.settingStore?.get('LoRA Sidebar.General.smartHover', true) ?? true;
    }

    async showSimplePreview(loraName, x, y) {
        debug.log('Showing simple preview:', {
            loraName, x, y
        });

        // Clean up any existing preview first
        if (this.activePreviewCleanup) {
            this.activePreviewCleanup();
            this.activePreviewCleanup = null;
        }

        try {
            // Get LoRA info
            const response = await fetch(`/lora_sidebar/info/${encodeURIComponent(loraName)}`);
            if (!response.ok) {
                console.error('Failed to fetch LoRA info:', response.status);
                return false;
            }

            const data = await response.json();
            if (data.status !== "success" || !data.info) {
                console.error('Invalid LoRA info response:', data);
                return false;
            }

            // Create preview element
            const previewElement = document.createElement('div');
            previewElement.className = 'lora-preview-popup';
            
            // Get preview URL and prepare content
            const filename = data.info.path.split('\\').pop().replace('.safetensors', '');
            const previewUrl = `/lora_sidebar/preview/${encodeURIComponent(filename)}?cb=${Date.now()}`;

            // Prepare trained words section if enabled
            let trainedWordsHtml = '';
            if (this.showTrained && data.info.trained_words?.length > 0) {
                trainedWordsHtml = `
                    <div class="text-sm mt-2 opacity-70">
                        <div class="font-bold">Trained Words:</div>
                        <div class="italic">${data.info.trained_words.join(', ')}</div>
                    </div>
                `;
            }

            // Add content with size-constrained image
            previewElement.innerHTML = `
                <div class="p-panel-content">
                    <img src="${previewUrl}" alt="${data.info.name}" style="max-width: 256px; max-height: 256px;">
                    <div class="mt-2">
                        <div class="font-bold">${data.info.name}</div>
                        ${data.info.description ? `<div class="text-sm opacity-80">${data.info.description}</div>` : ''}
                        ${data.info.trigger_phrase ? `<div class="text-sm opacity-70 italic">Trigger: ${data.info.trigger_phrase}</div>` : ''}
                        ${trainedWordsHtml}
                    </div>
                </div>
            `;

            // Calculate position considering window boundaries
            const padding = 20;
            const windowWidth = window.innerWidth;
            const windowHeight = window.innerHeight;
            
            // Add to document temporarily to get dimensions
            previewElement.style.visibility = 'hidden';
            document.body.appendChild(previewElement);
            
            // Get dimensions
            const previewWidth = previewElement.offsetWidth;
            const previewHeight = previewElement.offsetHeight;
            
            // Calculate position
            let finalX = x + padding;
            let finalY = y;
            
            // Adjust if would go off screen
            if (finalX + previewWidth > windowWidth) {
                finalX = x - previewWidth - padding;
            }
            
            if (finalY + previewHeight > windowHeight) {
                finalY = windowHeight - previewHeight - padding;
            }
            
            // Apply final position
            previewElement.style.position = 'fixed';
            previewElement.style.left = `${finalX}px`;
            previewElement.style.top = `${finalY}px`;
            previewElement.style.visibility = 'visible';
            previewElement.style.zIndex = '10000';

            // Create cleanup function
            const cleanup = () => {
                debug.log('Cleaning up preview');
                if (previewElement && previewElement.parentNode) {
                    previewElement.parentNode.removeChild(previewElement);
                }
                if (this.activePreviewCleanup === cleanup) {
                    this.activePreviewCleanup = null;
                }
            };

            // Store the active preview cleanup
            this.activePreviewCleanup = cleanup;

            return cleanup;

        } catch (error) {
            console.error('Error showing preview:', error);
            return false;
        }
    }

    setupGraphMonitor() {

        if (!this.enabled || !this.showCanvas) {
            debug.log(this.enabled, this.showCanvas);
            return;
        }

        // Wait for canvas methods to be defined
        if (!this.app.canvas.processNodeWidgets) {
            setTimeout(() => this.setupGraphMonitor(), 100);
            return;
        }

        const self = this;
        // Get actual LGraphCanvas instance
        const actualCanvas = this.app.canvas;
        const origNodeMouse = LGraphCanvas.prototype.processNodeWidgets;
        const origShowMenu = LGraphCanvas.prototype.showContextMenu;
    
        if (!origNodeMouse) return;

        debug.log("Current app:", this.app);
        debug.log("Graph:", this.app.graph);
        debug.log("Canvas:", this.app.canvas);



        debug.log("Is LGraphCanvas?", actualCanvas instanceof LGraphCanvas);
        debug.log("Canvas properties:", Object.keys(actualCanvas));
        debug.log("Canvas:", actualCanvas);

        // Add canvas click handler
        actualCanvas.onMouseDown = function(event) {
            this.adjustMouseEvent(event);
            
            // If clicked on empty canvas, clear any preview
            const node = this.graph.getNodeOnPos(event.canvasX, event.canvasY);
            if (!node && self.lastNodePreviewClear) {
                debug.log("Canvas click detected, clearing preview");
                self.lastNodePreviewClear();
                self.lastNodePreviewClear = null;
                self.lastNode = null;
                self.lastLoraValue = null;
            }
            return true;
        };

        // Create proxy for zoom detection because lgraph is a POS
        const handler = {
            set(target, property, value) {
                if (property === "scale") {
                    debug.log("Zoom detected via scale change:", value);
                    if (self.lastNodePreviewClear) {
                        debug.log("Clearing preview from zoom");
                        self.lastNodePreviewClear();
                        self.lastNodePreviewClear = null;
                        self.lastNode = null;
                        self.lastLoraValue = null;
                    }
                }
                target[property] = value;
                return true;
            }
        };

        // Create proxy for the canvas's ds (drag & scale) object
        actualCanvas.ds = new Proxy(actualCanvas.ds, handler);

        // Make sure events are bound
        actualCanvas.bindEvents();

        // menu handler to cleanup preview
        LGraphCanvas.prototype.showContextMenu = function(values, options, e, prev_menu) {
            if (self.lastNodePreviewClear) {
                self.lastNodePreviewClear();
                self.lastNodePreviewClear = null;
            }
            return origShowMenu.call(this, values, options, e, prev_menu);
        };
        
        // Override widget processing
        LGraphCanvas.prototype.processNodeWidgets = function(node, pos, event, active_widget) {
            const result = origNodeMouse.call(this, node, pos, event, active_widget);
            
            // Early return if feature is disabled
            if (!self.isEnabled()) return result;                
    
            // Only process click events
            if (node && event?.type === "pointerdown") {
                // Early return if it's the same node being clicked
                if (node === self.lastNode && self.lastLoraValue == null) {
                    return result;
                }
    
                // Find any LoRA widget in the node
                const widget = node.widgets?.find(w => {
                    const isLoraName = w.name === "lora_name";
                    const isLoraNumbered = w.name.match(/^lora_\d+$/);
                    const isRgthreeLora = node.type === "Power Lora Loader (rgthree)" && 
                                        w.name === "string" && 
                                        w.value && 
                                        typeof w.value === 'object' && 
                                        'lora' in w.value;
                    
                    return isLoraName || isLoraNumbered || isRgthreeLora;
                });
    
                if (widget) {
                    const currentValue = widget.value;
                    const isSameValue = currentValue === self.lastLoraValue;
    
                    // Only process if value changed
                    if (!isSameValue) {
                        const loraName = self.extractLoraName(widget, node);
                        if (loraName) {
                            // Update tracking values
                            self.lastNode = node;
                            self.lastLoraValue = currentValue;
    
                            if (self.isSidebarOpen()) {
                                self.showLoraInfo(loraName);
                            } else {

                                if (self.menuIsOpening) {
                                    debug.log("Menu is opening, skipping preview");
                                    return result;
                                }

                                // Use the proper LGraphCanvas instance through self
                                const canvas = actualCanvas;

                                const currentZoom = actualCanvas.ds.scale;
                                if (currentZoom < (self.zoomLevel / 100)) {
                                    console.info("Zoom too far out for preview:", self.zoomLevel);
                                    return;
                                }
                                
                                // Get node dimensions to see how big it is
                                const nodeBounds = node.getBounding();
                                const nodeHeight = nodeBounds[3] * canvas.ds.scale; // Height in screen space

                                // Try to get node's screen position
                                function getNodeScreenCoordinates(node, graphCanvas) {
                                    // 1. Get raw data
                                    const nodePos = {
                                        x: node.pos[0],
                                        y: node.pos[1]
                                    };
                                    const canvasData = {
                                        offset: graphCanvas.ds.offset,
                                        scale: graphCanvas.ds.scale,
                                        rect: graphCanvas.canvas.getBoundingClientRect(),
                                        width: graphCanvas.canvas.width
                                    };
                                    
                                    // 2. Calculate base positions
                                    const scaleCompensation = (1 - canvasData.scale) * 0;
                                    const transformedPos = {
                                        x: (nodePos.x + canvasData.offset[0]) * canvasData.scale + scaleCompensation,
                                        y: (nodePos.y + canvasData.offset[1]) * canvasData.scale + scaleCompensation,
                                        //y: (nodePos.y * canvasData.scale) + canvasData.offset[1]
                                    };
                                    
                                    // 3. Calculate screen bounds
                                    const screenPos = {
                                        x: canvasData.rect.left + transformedPos.x,
                                        y: canvasData.rect.top + transformedPos.y
                                    };
                                    
                                    // 4. Calculate distance from center
                                    const canvasCenter = canvasData.width / 2;
                                    const distanceFromCenter = nodePos.x - canvasCenter;
                                    
                                    // 5. Build final bounds
                                    const rawBounds = {
                                        left: screenPos.x,
                                        right: screenPos.x + (nodeBounds[2] * canvasData.scale),
                                        top: screenPos.y,
                                        height: nodeBounds[3] * canvasData.scale
                                    };
                                    
                                    const correctedBounds = {
                                        left: rawBounds.left * canvasData.scale,
                                        right: rawBounds.right * canvasData.scale,
                                        top: rawBounds.top * canvasData.scale,
                                        height: rawBounds.height * canvasData.scale
                                    };
                                
                                    // Debug logs
                                    debug.log("Node bounds:", {
                                        raw: rawBounds,
                                        corrected: correctedBounds,
                                        scale: canvasData.scale
                                    });
                                    debug.log("Distance from center:", {
                                        canvasWidth: canvasData.width,
                                        canvasCenter,
                                        nodePos: nodePos.x,
                                        distance: distanceFromCenter
                                    });
                                    debug.log("Position calculations:", {
                                        rawPos: nodePos.x,
                                        scale: canvasData.scale,
                                        transformed: transformedPos,
                                        withoutScale: nodePos.x + canvasData.offset[0],
                                        scaleFirst: (nodePos.x + canvasData.offset[0]) * canvasData.scale
                                    });
                                
                                    return {
                                        bounds: correctedBounds,
                                        transformedX: screenPos.x,
                                        transformedY: screenPos.y,
                                        distanceFromCenter,
                                        height: rawBounds.height
                                    };
                                }
                                
                                const nodeInfo = getNodeScreenCoordinates(node, canvas);
                                const nodeScreenPos = nodeInfo.bounds;
                                const canvasScale = canvas.ds.scale;

                                // distanceFromCenter = nodeInfo.distanceFromCenter;
                                
                                // Calculate final position with zoom compensation
                                const padding = 3;
                                const scaledPadding = padding //* (1 / canvas.ds.scale)
                                // Fix for weird drift BS
                                const baseMultiplier = 0.001;
                                const zoomCompensation = 1 / canvasScale;
                                const offsetMultiplier = baseMultiplier * zoomCompensation;
                                const centerOffset = nodeInfo.distanceFromCenter * offsetMultiplier;

                                const finalPos = {
                                    x: nodeInfo.transformedX - scaledPadding + centerOffset,
                                    y: nodeInfo.transformedY + (nodeInfo.height / 2)
                                    //y: nodeInfo.transformedY - scaledPadding + centerOffset,
                                    //y: nodeScreenPos.top + (nodeScreenPos.height * .5)
                                };

                                // Final debug logs
                                debug.log("Final position:", {
                                    nodeLeft: nodeScreenPos.left,
                                    originCompensation: centerOffset,
                                    finalLeft: nodeScreenPos.left + centerOffset,
                                    finalPos,
                                    mouseClick: { x: event.x, y: event.y }
                                });
                            
                                if (self.lastNodePreviewClear) {
                                    debug.log("Clearing last node preview.");
                                    self.lastNodePreviewClear();
                                    self.lastNodePreviewClear = null;
                                }
                            
                                // Check if menu exists or appears within a few ms
                                setTimeout(async () => {
                                    const menuExists = document.querySelector('.litecontextmenu');
                                    if (!menuExists) {
                                        // Only show preview if no menu appeared
                                        self.showPreviewOnCanvas(
                                            loraName,
                                            finalPos.x,
                                            finalPos.y,
                                            null,
                                            nodeHeight,
                                            canvasScale
                                        ).then(cleanupFunc => {
                                            debug.log("Preview successfully created for node:", node.id);
                                            self.lastNodePreviewClear = cleanupFunc;
                                        }).catch(error => {
                                            console.error("Failed to create preview for node:", node.id, "Error:", error);
                                        });
                                    }
                                }, 30);  // Small delay to check for menu
                            }
                        }
                    }
                } else {
                    // Reset tracking if not a LoRA node
                    self.lastNode = null;
                    self.lastLoraValue = null;
                    if (self.lastNodePreviewClear) {
                        self.lastNodePreviewClear();
                        self.lastNodePreviewClear = null;
                    }
                }
            } else if (event?.type === "pointerup") {
                // Only reset node tracking on mouse up outside nodes
                if (!node) {
                    self.lastNode = null;
                    self.lastLoraValue = null;
                    if (self.lastNodePreviewClear) {
                        self.lastNodePreviewClear();
                        self.lastNodePreviewClear = null;
                    }
                }
            }

            checkCanvasReady();
            
            return result;
        };
    }

    setupMenuObserver() {
        if (!this.enabled || !this.showMenu) return;

        debug.log("Setting up menu observer");
        const self = this;

        // Hook directly into ContextMenu creation
        const origContextMenu = LiteGraph.ContextMenu;
        LiteGraph.ContextMenu = function(values, options) {
            // Debug the full structure
            debug.log("ContextMenu called with:", {
                values: values?.slice(0, 3), // First 3 items for brevity
                options: {
                    callback: options?.callback ? "function present" : "no callback",
                    event: options?.event ? options.event.type : "no event",
                    node: options?.node ? {
                        type: options.node.type,
                        widgets: options.node.widgets?.map(w => ({
                            name: w.name,
                            type: w.type,
                            value: w.value
                        }))
                    } : "no node"
                }
            });

            // Check if this is a file selection menu for LoRAs
            const isLoraMenu = values?.some(v => 
                typeof v === 'string' && 
                v.toLowerCase().includes('.safetensors')
            );

            debug.log("Menu analysis:", {
                isLoraMenu,
                valueCount: values?.length,
                firstValue: values?.[0],
                menuType: 'contextmenu'
            });

            if (isLoraMenu) {
                debug.log("LoRA menu detected - creating menu");
                const menu = new origContextMenu(values, options);
                const menuElement = menu.root;

                // Process menu items once created
                setTimeout(() => {
                    const cleanup = handleMenuItems(menuElement);
                    
                    // Watch for menu removal
                    const menuRemovalObserver = new MutationObserver((mutations) => {
                        mutations.forEach(mutation => {
                            mutation.removedNodes.forEach(node => {
                                if (node === menuElement) {
                                    if (cleanup) cleanup();
                                    menuRemovalObserver.disconnect();
                                    debug.log("Menu removed, cleanup complete");
                                }
                            });
                        });
                    });

                    menuRemovalObserver.observe(menuElement.parentNode, {
                        childList: true
                    });
                }, 0);

                return menu;
            }

            return new origContextMenu(values, options);
        };

        const handleMenuItems = (menuElement) => {
            debug.log("Processing menu items in:", menuElement);
            
            // Fix pointer-events on the menu container
            menuElement.style.pointerEvents = 'auto';
            
            const items = menuElement.querySelectorAll('.litemenu-entry');
            debug.log(`Found ${items.length} menu items`);

            items.forEach(item => {
                const dataValue = item.getAttribute('data-value');
                debug.log("Menu item:", {
                    text: item.textContent,
                    dataValue,
                    className: item.className
                });

                if (!dataValue?.toLowerCase().includes('.safetensors')) return;

                item.style.pointerEvents = 'auto';

                let clearPreview = null;
                
                const mouseEnterHandler = (e) => {
                    debug.log("Mouse enter on LoRA item:", dataValue);
                    if (self.menuDebounceTimer) {
                        clearTimeout(self.menuDebounceTimer);
                    }

                    self.menuDebounceTimer = setTimeout(async () => {
                        const cleanName = dataValue.split('\\').pop().replace(/\.[^/.]+$/, '');
                        
                        if (self.isSidebarOpen()) {
                            self.showLoraInfo(cleanName);
                        } else {
                            if (clearPreview) {
                                clearPreview();
                                clearPreview = null;
                            }
                            
                            clearPreview = await self.showSimplePreview(
                                cleanName,
                                e.clientX,
                                e.clientY
                            );
                        }
                    }, self.menuDebounceDelay);
                };

                const mouseLeaveHandler = () => {
                    debug.log("Mouse leave LoRA item:", dataValue);
                    if (self.menuDebounceTimer) {
                        clearTimeout(self.menuDebounceTimer);
                        self.menuDebounceTimer = null;
                    }
                    if (clearPreview) {
                        clearPreview();
                        clearPreview = null;
                    }
                };

                item.addEventListener('mouseenter', mouseEnterHandler);
                item.addEventListener('mouseleave', mouseLeaveHandler);
                
                // Store handlers for cleanup
                item._handlers = {
                    enter: mouseEnterHandler,
                    leave: mouseLeaveHandler
                };
            });

            return () => {
                debug.log("Cleaning up menu items");
                items.forEach(item => {
                    if (item._handlers) {
                        item.removeEventListener('mouseenter', item._handlers.enter);
                        item.removeEventListener('mouseleave', item._handlers.leave);
                        delete item._handlers;
                    }
                });
            };
        };
    }

    extractLoraName(widget, node) {
        // Handle different value formats
        const getValue = (value) => {
            if (!value) return '';
            
            // If it's a string, return it directly
            if (typeof value === 'string') return value;
            
            // If it's an object, try different known properties
            if (typeof value === 'object') {
                // For Power Lora Loader, just get the filename from the lora path
                if (node?.type === "Power Lora Loader (rgthree)" && value.lora) {
                    return value.lora;
                }

                if (value.content) return value.content;
                if (value.lora) return value.lora;
                if (value.string) return value.string;
                
                // RGThree specific: look for any property that might contain a .safetensors path
                for (const key in value) {
                    if (typeof value[key] === 'string' && value[key].includes('.safetensors')) {
                        return value[key];
                    }
                }
                
                // Last resort, try to stringify
                try {
                    if (typeof value.toString === 'function') {
                        const str = value.toString();
                        if (str !== '[object Object]') return str;
                    }
                } catch (e) {
                    console.debug("Failed to convert LoRA value to string:", e);
                }
            }
            
            return '';
        };

        let loraName = '';
        try {
            if (node.type === "Power Lora Loader (rgthree)" && widget.name === "string") {
                const data = typeof widget.value === 'string' ? JSON.parse(widget.value) : widget.value;
                loraName = getValue(data);
            } else {
                loraName = getValue(widget.value);
            }

            if (loraName) {
                loraName = loraName.split('\\').pop();
                loraName = loraName.replace(/\.[^/.]+$/, '');
            }
        } catch (e) {
            console.error("Error extracting LoRA name:", e);
            return '';
        }

        return loraName;
    }

    async showLoraInfo(loraName) {
        // Double check sidebar is still open
        if (!this.isSidebarOpen()) {
            this.sidebar.showToast(
                "info",
                "LoRA Sidebar Required",
                "Open the LoRA Sidebar to see LoRA information when clicking nodes"
            );
            return;
        }

        // Get actual lora name from info.json
        try {
            const response = await fetch(`/lora_sidebar/info/${encodeURIComponent(loraName)}`);
            if (response.ok) {
                const data = await response.json();
                if (data.status === "success") {
                    // Use the proper name from the info.json for the lookup
                    const properLoraName = data.info.name;
                    const lora = this.sidebar.loraData.find(l => l.name === properLoraName);
                    
                    if (lora) {
                        this.sidebar.showLoraInfo(lora, null);
                        return;
                    }
                }
            }
        } catch (error) {
            console.error("Failed to fetch LoRA info:", error);
        }

        this.sidebar.showToast(
            "warn",
            "LoRA Not Found",
            "Could not find matching LoRA in sidebar data"
        );
    }

    checkCurrentDisplayedLora() {
        // If no popup exists, no need to check further
        if (!this.sidebar.currentPopup) {
            return null;
        }
    
        // Get name from the current popup
        const nameElement = this.sidebar.currentPopup.querySelector('.lora-name');
        if (!nameElement) {
            return null;
        }
        
        return nameElement.textContent.trim();
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        if (!enabled) {
            if (this.currentHoverTimer) {
                clearTimeout(this.currentHoverTimer);
                this.currentHoverTimer = null;
            }
            if (this.menuDebounceTimer) {
                clearTimeout(this.menuDebounceTimer);
                this.menuDebounceTimer = null;
            }
            this.lastNode = null;  // Reset last node when disabled
        }
    }

    updateShowTrained(newVal) {
        this.showTrained = newVal;
        debug.log("Updated showTrained:", this.showTrained);
    }

    updateZoomLevel(newVal) {
        this.zoomLevel = newVal;
        debug.log("Updated zoomLevel:", this.zoomLevel);
    }

    updateShowOnMenu(newVal) {
        this.showMenu = newVal;
        debug.log("Updated showMenu:", this.showMenu);
    }

    updateShowOnCanvas(newVal) {
        this.showCanvas = newVal;
        debug.log("Updated showCanvas:", this.showCanvas);
    }

    updateShowSidebar(newVal) {
        this.showSidebar = newVal;
        debug.log("Updated showSidebar:", this.showSidebar);
    }

    async showPreviewOnCanvas(loraName, x, y, node) {
        if (!node) {
            console.error("Node object is required for preview positioning");
            return null;
        }

        // Check zoom level first
        const currentZoom = app.canvas.ds.scale;
        if (currentZoom < (this.zoomLevel / 100)) {
            debug.log("Zoom too far out for preview, current:", currentZoom, "threshold:", this.zoomLevel / 100);
            return null;
        }

        try {
            const response = await fetch(`/lora_sidebar/info/${encodeURIComponent(loraName)}`);
            if (!response.ok) return null;
            
            const data = await response.json();
            if (data.status !== "success" || !data.info) return null;

            // Create preview element
            const previewElement = document.createElement('div');
            previewElement.className = 'lora-preview-popup';
            
            // Get node dimensions using getBounding()
            const rect = node.getBounding();
            const nodeHeight = rect[3];  // rect[3] is height
            
            // Calculate max preview size based on node height
            const maxPreviewSize = Math.min(256, nodeHeight * 1.5);
            
            // Get preview URL and prepare content
            const filename = data.info.path.split('\\').pop().replace('.safetensors', '');
            const previewUrl = `/lora_sidebar/preview/${encodeURIComponent(filename)}?cb=${Date.now()}`;

            // Prepare trained words section if enabled
            let trainedWordsHtml = '';
            if (this.showTrained && data.info.trained_words?.length > 0) {
                trainedWordsHtml = `
                    <div class="text-sm mt-2 opacity-70">
                        <div class="font-bold">Trained Words:</div>
                        <div class="italic">${data.info.trained_words.join(', ')}</div>
                    </div>
                `;
            }

            // Add content with size-constrained image
            previewElement.innerHTML = `
                <div class="p-panel-content">
                    <img src="${previewUrl}" alt="${data.info.name}" style="max-width: ${maxPreviewSize}px; max-height: ${maxPreviewSize}px;">
                    <div class="mt-2">
                        <div class="font-bold">${data.info.name}</div>
                        ${data.info.description ? `<div class="text-sm opacity-80">${data.info.description}</div>` : ''}
                        ${data.info.trigger_phrase ? `<div class="text-sm opacity-70 italic">Trigger: ${data.info.trigger_phrase}</div>` : ''}
                        ${trainedWordsHtml}
                    </div>
                </div>
            `;
            
            const previewWidth = maxPreviewSize + 27; // Add some padding for the container
            const gap = 5; // Reduced gap by 20%
            
            // Position preview to the left of the node with adjusted gap
            previewElement.style.position = 'fixed';
            previewElement.style.left = `${x - previewWidth - gap}px`;
            previewElement.style.top = `${y}px`;
            previewElement.style.zIndex = '9999';
            
            document.body.appendChild(previewElement);

            return () => {
                if (previewElement && previewElement.parentNode) {
                    previewElement.parentNode.removeChild(previewElement);
                }
            };

        } catch (error) {
            console.error('Error showing preview:', error);
            return null;
        }
    }

}

export default LoraSmartInfo;
