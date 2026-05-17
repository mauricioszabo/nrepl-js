(ns nrepl-js.scope-map
  (:require [clojure.string :as str]))

(def greatest-lower-bound 1)
(def least-upper-bound 2)

(defn- traverse [parsed f]
  (js* "require('@babel/traverse').default(~{}, { enter: function(p) { ~{}(p); } })"
       parsed f))

(defn- loc->map [^js loc]
  (when loc
    {:start {:line (.. loc -start -line)
             :column (.. loc -start -column)}
     :end {:line (.. loc -end -line)
           :column (.. loc -end -column)}}))

(defn- node-loc [^js node]
  (or (.-loc node)
      (let [body (.-body node)
            body-seq (when body (array-seq body))
            ^js first-node (first body-seq)
            ^js last-node (last body-seq)]
        (when (and first-node last-node (.-loc first-node) (.-loc last-node))
          #js {:start (.. first-node -loc -start)
               :end (.. last-node -loc -end)}))))

(defn- pos<= [a b]
  (or (< (:line a) (:line b))
      (and (= (:line a) (:line b))
           (<= (:column a) (:column b)))))

(defn- pos< [a b]
  (or (< (:line a) (:line b))
      (and (= (:line a) (:line b))
           (< (:column a) (:column b)))))

(defn position-in-range? [{:keys [start end]} line column]
  (let [pos {:line line :column column}]
    (and (pos<= start pos)
         (pos< pos end))))

(defn- range-size [{:keys [start end]}]
  (+ (* 1000000 (- (:line end) (:line start)))
     (- (:column end) (:column start))))

(defn- identifier-part? [ch]
  (and ch (re-matches #"[$_A-Za-z0-9]" ch)))

(defn- identifier-start? [ch]
  (and ch (re-matches #"[$_A-Za-z]" ch)))

(defn- whitespace? [ch]
  (and ch (re-matches #"\s" ch)))

(defn- char-at [s idx]
  (when (and s (>= idx 0) (< idx (count s)))
    (.charAt s idx)))

(defn- expand-identifier [line-text idx]
  (let [length (count line-text)]
    (when (and (>= idx 0) (< idx length) (identifier-part? (char-at line-text idx)))
      (let [start (loop [i idx]
                    (if (and (> i 0) (identifier-part? (char-at line-text (dec i))))
                      (recur (dec i))
                      i))
            end (loop [i (inc idx)]
                  (if (and (< i length) (identifier-part? (char-at line-text i)))
                    (recur (inc i))
                    i))
            token (subs line-text start end)]
        (when (identifier-start? (subs token 0 1))
          {:name token
           :start-column start
           :end-column end})))))

(defn- identifier-at-column [line-text column]
  (let [length (count line-text)
        column (-> column (max 0) (min (max 0 (dec length))))]
    (or (expand-identifier line-text column)
        (expand-identifier line-text (dec column))
        (let [right (loop [i column]
                      (cond
                        (>= i length) nil
                        (whitespace? (char-at line-text i)) (recur (inc i))
                        :else i))]
          (when right
            (expand-identifier line-text right))))))

(defn- identifier-at [generated-lines {:keys [line column]}]
  (when-let [line-text (nth generated-lines (dec line) nil)]
    (when-let [identifier (identifier-at-column line-text column)]
      (assoc identifier :line line))))

(defn- generated-position [^js consumer source-name line column bias]
  (let [pos (.generatedPositionFor consumer
                                   #js {:source source-name
                                        :line line
                                        :column column
                                        :bias bias})
        line (.-line pos)
        column (.-column pos)]
    (when (and line (some? column))
      {:line line :column column})))

(defn- generated-candidates [consumer source-name line column]
  (->> [greatest-lower-bound least-upper-bound nil]
       (keep #(generated-position consumer source-name line column %))
       distinct))

(defn- generated-identifier-for [consumer generated-lines source-name ^js loc]
  (let [^js start (.-start loc)
        line (.-line start)
        column (.-column start)]
    (->> (generated-candidates consumer source-name line column)
         (keep (fn [pos]
                 (when-let [identifier (identifier-at generated-lines pos)]
                   (assoc pos
                          :name (:name identifier)
                          :start-column (:start-column identifier)
                          :end-column (:end-column identifier)))))
         first)))

(defn- generated-range-for [consumer source-name ^js loc]
  (when loc
    (let [^js loc-start (.-start loc)
          ^js loc-end (.-end loc)
          start (or (generated-position consumer source-name
                                        (.-line loc-start)
                                        (.-column loc-start)
                                        least-upper-bound)
                    (generated-position consumer source-name
                                        (.-line loc-start)
                                        (.-column loc-start)
                                        greatest-lower-bound))
          end (or (generated-position consumer source-name
                                      (.-line loc-end)
                                      (.-column loc-end)
                                      greatest-lower-bound)
                  (generated-position consumer source-name
                                      (.-line loc-end)
                                      (.-column loc-end)
                                      least-upper-bound))]
      (when (or start end)
        {:start start
         :end end}))))

(defn- function-name [^js node]
  (or (some-> node .-id .-name)
      (some-> node .-key .-name)
      (some-> node .-key .-value str)))

(defn- scope-name [^js path]
  (or (function-name (.-node path))
      (some-> path .-parent .-id .-name)
      (some-> path .-parent .-key .-name)
      "<anonymous>"))

(defn- binding-entry [consumer generated-lines source-name original-name ^js binding]
  (let [identifier (.-identifier binding)
        loc (.-loc identifier)
        generated (when loc
                    (generated-identifier-for consumer generated-lines source-name loc))]
    {:original original-name
     :generated (:name generated)
     :kind (.-kind binding)
     :original-loc (loc->map loc)
     :generated-loc (when generated
                      {:line (:line generated)
                       :column (:start-column generated)
                       :end-column (:end-column generated)})}))

(defn- bindings-for-scope [consumer generated-lines source-name ^js scope]
  (let [bindings (.-bindings scope)]
    (->> (array-seq (js/Object.entries bindings))
         (mapv (fn [entry]
                 (binding-entry consumer
                                generated-lines
                                source-name
                                (aget entry 0)
                                (aget entry 1)))))))

(defn- collect-scopes [parsed consumer generated-lines source-name]
  (let [seen (js/WeakSet.)
        ids (js/WeakMap.)
        scopes (atom [])]
    (traverse
     parsed
     (fn [^js path]
       (let [^js scope (.-scope path)]
         (when (and scope
                    (identical? (.-path scope) path)
                    (not (.has seen scope)))
           (.add seen scope)
           (let [id (count @scopes)
                 parent-id (when-let [^js parent (.-parent scope)]
                             (.get ids parent))
                 ^js node (.-node path)
                 loc (node-loc node)
                 bindings (bindings-for-scope consumer generated-lines source-name scope)]
             (.set ids scope id)
             (swap! scopes conj
                    {:id id
                     :parent-id parent-id
                     :type (.-type node)
                     :name (scope-name path)
                     :range (loc->map loc)
                     :generated-range (generated-range-for consumer source-name loc)
                     :bindings bindings
                     :names (into {}
                                  (keep (fn [{:keys [original generated]}]
                                          (when generated [original generated]))
                                        bindings))
                     :unmapped (into []
                                     (keep (fn [{:keys [original generated]}]
                                             (when-not generated original))
                                           bindings))}))))))
    @scopes))

(defn- aggregate-names [scopes]
  (reduce
   (fn [acc {:keys [names]}]
     (reduce-kv
      (fn [acc original generated]
        (update acc original (fnil conj #{}) generated))
      acc
      names))
   {}
   scopes))

(defn build-scope-map
  "Builds source-mapped lexical scope data.

  `original-ast` is a Babel AST for one original source file.
  `source-map-consumer` must already be parsed and must implement the
  source-map SourceMapConsumer API (`generatedPositionFor`, `sources`).
  `generated-source` is the JavaScript text that V8 executes.
  `source-name` must be the exact source name understood by the sourcemap.

  The returned data keeps per-scope `:names` as original-name -> generated-name.
  Use `name-map-at` to get the visible original-name -> generated-name map at
  an original source position."
  [original-ast ^js source-map-consumer generated-source source-name]
  (when-not source-name
    (throw (js/Error. "build-scope-map requires source-name")))
  (let [generated-lines (str/split generated-source #"\r\n|\n|\r")
        scopes (collect-scopes original-ast source-map-consumer generated-lines source-name)]
    {:source source-name
     :scopes scopes
     :names (aggregate-names scopes)}))

(def source-map->scope-map build-scope-map)

(defn scope-chain-at [scope-map line column]
  (->> (:scopes scope-map)
       (filter (fn [{:keys [range]}]
                 (and range (position-in-range? range line column))))
       (sort-by (juxt #(count (take-while some? (iterate (fn [id]
                                                            (:parent-id (some (fn [scope]
                                                                                (when (= (:id scope) id)
                                                                                  scope))
                                                                              (:scopes scope-map))))
                                                         (:id %))))
                      #(range-size (:range %))))))

(defn name-map-at
  "Returns the visible original-name -> generated-name map for an original
  source position. Outer scopes are merged first, so inner scopes win."
  [scope-map line column]
  (reduce merge {} (map :names (scope-chain-at scope-map line column))))
