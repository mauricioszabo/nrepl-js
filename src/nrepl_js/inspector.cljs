(ns nrepl-js.inspector
  (:require ["node:http" :as http]
            [promesa.core :as p]))

(declare format-target-list)

(defn- http-get [{:keys [host port path timeout-ms]}]
  (p/create
   (fn [resolve reject]
     (let [req (.get http #js {:host host :port port :path path :agent false}
                     (fn [^js res]
                       (let [chunks (array)]
                         (.on res "data" (fn [c] (.push chunks c)))
                         (.on res "end" (fn [] (resolve (.toString (js/Buffer.concat chunks) "utf8"))))
                         (.on res "error" (fn [])))))]
       (.on req "error" (fn [err] (reject err)))
       (.on req "socket" (fn [^js s] (.on s "error" (fn []))))
       (.setTimeout req timeout-ms (fn [] (try (.destroy req (js/Error. "inspector discovery timeout")) (catch :default _))))))))

(defn- try-list-targets [{:keys [host port timeout-ms deadline]}]
  (-> (http-get {:host host :port port :path "/json/list" :timeout-ms 1000})
      (p/then (fn [body]
                (let [targets (js/JSON.parse body)]
                  (if (or (not (array? targets)) (zero? (.-length targets)))
                    (p/rejected (js/Error. "empty target list"))
                    targets))))
      (p/catch (fn [err]
                 (if (>= (js/Date.now) deadline)
                   (p/rejected (js/Error. (str "inspector discovery failed at http://" host ":" port ": " (.-message err))))
                   (p/let [_ (p/delay 50)]
                     (try-list-targets {:host host :port port :timeout-ms timeout-ms :deadline deadline})))))))

(defn list-targets
  ([] (list-targets {}))
  ([{:keys [host port timeout-ms] :or {host "127.0.0.1" port 9229 timeout-ms 5000}}]
   (try-list-targets {:host host :port port :timeout-ms timeout-ms :deadline (+ (js/Date.now) timeout-ms)})))

(defn- target-fields [^js target]
  (->> [(.-id target) (.-type target) (.-title target) (.-url target) (.-description target)]
       (filter #(and (not (nil? %)) (not (undefined? %))))
       (map str)))

(defn- target-search-text [target]
  (.toLowerCase (.join (into-array (target-fields target)) "\n")))

(defn select-target
  ([targets] (select-target targets nil))
  ([targets selector]
   (let [debuggable (filter #(.-webSocketDebuggerUrl ^js %) (array-seq targets))]
     (when (empty? debuggable)
       (throw (js/Error. "no debuggable targets found")))
     (if (nil? selector)
       (first debuggable)
       (let [query (.toLowerCase (str selector))
             matches (filter #(.includes (target-search-text %) query) debuggable)]
         (when (empty? matches)
           (throw (js/Error. (str "no target matching " (js/JSON.stringify selector) "\n" (format-target-list (into-array debuggable))))))
         (if (= 1 (count matches))
           (first matches)
           (let [exact (filter #(some (fn [f] (= (.toLowerCase f) query)) (target-fields %)) matches)]
             (if (= 1 (count exact))
               (first exact)
               (let [title-prefix (filter #(.startsWith (.toLowerCase (str (.-title ^js %) "")) query) matches)]
                 (if (= 1 (count title-prefix))
                   (first title-prefix)
                   (throw (js/Error. (str "target selector " (js/JSON.stringify selector) " matched multiple targets\n" (format-target-list (into-array matches)))))))))))))))

(defn format-target-list [targets]
  (.join (into-array
          (map-indexed
           (fn [i ^js target]
             (let [title (or (.-title target) "(untitled)")
                   type (or (.-type target) "unknown")
                   url (or (.-url target) "")
                   id (or (.-id target) "")]
               (str (inc i) ". [" type "] " title
                    (when (seq url) (str " - " url))
                    (when (seq id) (str " (" id ")")))))
           (array-seq targets)))
         "\n"))

(defn discover
  ([] (discover {}))
  ([{:keys [host port timeout-ms target] :or {host "127.0.0.1" port 9229 timeout-ms 5000}}]
   (p/let [targets (list-targets {:host host :port port :timeout-ms timeout-ms})
           ^js selected (select-target targets target)]
     (.-webSocketDebuggerUrl selected))))
