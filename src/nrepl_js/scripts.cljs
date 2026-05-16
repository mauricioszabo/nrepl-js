(ns nrepl-js.scripts
  (:require ["node:url" :refer [fileURLToPath]]
            ["node:path" :as path]
            [nrepl-js.cdp-interop :as cdp]))

(defn create-script-registry [^js cdp]
  (let [by-id (new js/Map)
        by-path (new js/Map)
        by-url (new js/Map)]
    (cdp/on cdp "Debugger.scriptParsed"
            (fn [{:keys [scriptId url]}]
              (let [url (or url "")
                   p (when (.startsWith url "file://")
                       (try (fileURLToPath url) (catch :default _ nil)))]
                (.set by-id scriptId #js {:url url :path p})
                (when p (.set by-path p scriptId))
                (when (seq url) (.set by-url url scriptId)))))
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
