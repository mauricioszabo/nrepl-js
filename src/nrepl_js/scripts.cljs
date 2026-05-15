(ns nrepl-js.scripts
  (:require ["node:url" :refer [fileURLToPath]]
            ["node:path" :as path]))

(defn create-script-registry [^js cdp]
  (let [by-id (new js/Map)
        by-path (new js/Map)
        by-url (new js/Map)]
    (.call (.-on cdp) cdp "Debugger.scriptParsed"
           (fn [^js params]
             (let [url (or (.-url params) "")
                   p (when (.startsWith url "file://")
                       (try (fileURLToPath url) (catch :default _ nil)))]
               (.set by-id (.-scriptId params) #js {:url url :path p})
               (when p (.set by-path p (.-scriptId params)))
               (when (seq url) (.set by-url url (.-scriptId params))))))
    #js {:scriptIdForPath (fn [file]
                            (let [abs (.resolve path file)]
                              (or (.get by-path abs) nil)))
         :scriptIdForUrl (fn [url]
                           (or (.get by-url url) nil))
         :scriptIdForFile (fn [file]
                            (when file
                              (if (re-find #"^[a-zA-Z][a-zA-Z\d+.-]*:" file)
                                (or (.get by-url file) nil)
                                (or (.get by-path (.resolve path file)) nil))))
         :info (fn [script-id]
                 (or (.get by-id script-id) nil))
         :all (fn []
                (js/Array.from (.entries by-id)))}))
