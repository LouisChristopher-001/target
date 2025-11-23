import React, { useState, useEffect } from "react";
import api from "./api";
import "./App.css";

function App() {
  const [activeTab, setActiveTab] = useState("dashboard");

  const [year, setYear] = useState(2025);
  const [month, setMonth] = useState(11);

  // Salesperson & brand mapping
  const [spName, setSpName] = useState("");
  const [spBrand, setSpBrand] = useState("");
  const [salespersons, setSalespersons] = useState([]);
  const [brandTable, setBrandTable] = useState([]);

  // Targets (bulk)
  const [targetsTable, setTargetsTable] = useState([]);

  // Upload (all salespersons in one file)
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadStatus, setUploadStatus] = useState("");

  // Dashboard
  const [dashboardData, setDashboardData] = useState([]);
  const [loadingDashboard, setLoadingDashboard] = useState(false);

  // Load salespersons once
  useEffect(() => {
    fetchSalespersons();
  }, []);

  const fetchSalespersons = async () => {
    try {
      const res = await api.get("/api/salespersons");
      const list = res.data || [];
      setSalespersons(list);
      setBrandTable(
        list.map((sp) => ({
          id: sp._id,
          name: sp.name,
          brand: sp.brand || ""
        }))
      );
    } catch (err) {
      console.error(err);
    }
  };

  const fetchDashboard = async () => {
    try {
      setLoadingDashboard(true);
      const res = await api.get("/api/dashboard", {
        params: { year, month }
      });
      const data = res.data || [];
      setDashboardData(data);
      // Initialise targets editing table from dashboard data
      setTargetsTable(
        data.map((row) => ({
          name: row.name,
          brand: row.brand,
          target: row.target || 0
        }))
      );
    } catch (err) {
      console.error(err);
      alert("Error loading dashboard");
    } finally {
      setLoadingDashboard(false);
    }
  };

  useEffect(() => {
    // load dashboard on first render
    fetchDashboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAddSalesperson = async (e) => {
    e.preventDefault();
    if (!spName.trim()) {
      alert("Salesperson name is required");
      return;
    }
    try {
      await api.post("/api/salespersons", {
        name: spName,
        brand: spBrand || null
      });
      setSpName("");
      setSpBrand("");
      await fetchSalespersons();
      await fetchDashboard();
      alert("Salesperson saved");
    } catch (err) {
      console.error(err);
      alert("Error saving salesperson");
    }
  };

  // Bulk save brands
  const handleBrandChange = (index, value) => {
    setBrandTable((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], brand: value };
      return copy;
    });
  };

  const handleSaveAllBrands = async () => {
    try {
      await api.post("/api/salespersons/bulk", {
        salespersons: brandTable.map((row) => ({
          id: row.id,
          brand: row.brand
        }))
      });
      await fetchSalespersons();
      await fetchDashboard();
      alert("All brands updated");
    } catch (err) {
      console.error(err);
      alert("Error updating brands");
    }
  };

  // Bulk save targets
  const handleTargetChange = (index, value) => {
    setTargetsTable((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], target: value };
      return copy;
    });
  };

  const handleSaveAllTargets = async () => {
    try {
      await api.post("/api/targets/bulk", {
        year,
        month,
        targets: targetsTable.map((row) => ({
          name: row.name,
          target: Number(row.target) || 0
        }))
      });
      await fetchDashboard();
      alert("Targets updated for all salespersons");
    } catch (err) {
      console.error(err);
      alert("Error updating targets");
    }
  };

  const handleUploadSales = async (e) => {
    e.preventDefault();

    if (!uploadFile) {
      alert("Please select an Excel file");
      return;
    }

    try {
      setUploadStatus("Uploading and processing...");
      const formData = new FormData();
      formData.append("file", uploadFile);
      formData.append("year", year);
      formData.append("month", month);

      await api.post("/api/upload-sales", formData, {
        headers: {
          "Content-Type": "multipart/form-data"
        }
      });

      setUploadStatus("Sales data processed successfully");
      setUploadFile(null);
      fetchDashboard();
    } catch (err) {
      console.error(err);
      setUploadStatus("Error processing file");
    }
  };

  const formatCurrency = (val) => {
    if (val == null) return "0";
    return val.toLocaleString("en-IN", {
      maximumFractionDigits: 0
    });
  };

  const formatPercent = (val) => {
    if (val == null) return "-";
    return val.toFixed(1) + "%";
  };

  // Small summary on top of dashboard
  const totalTargetAll = dashboardData.reduce(
    (sum, r) => sum + (r.target || 0),
    0
  );
  const totalAchAll = dashboardData.reduce(
    (sum, r) => sum + (r.totalAchievement || 0),
    0
  );
  const overallPercent =
    totalTargetAll > 0 ? (totalAchAll / totalTargetAll) * 100 : null;

  return (
    <div className="app-container">
      <header className="app-header">
        <h1>Sales Target Dashboard</h1>
        <div className="period-selector">
          <label>
            Year:
            <input
              type="number"
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
            />
          </label>
          <label>
            Month:
            <input
              type="number"
              min="1"
              max="12"
              value={month}
              onChange={(e) => setMonth(Number(e.target.value))}
            />
          </label>
          <button onClick={fetchDashboard}>Refresh Dashboard</button>
        </div>
      </header>

      <nav className="tabs">
        <button
          className={activeTab === "dashboard" ? "active" : ""}
          onClick={() => setActiveTab("dashboard")}
        >
          Dashboard
        </button>
        <button
          className={activeTab === "targets" ? "active" : ""}
          onClick={() => setActiveTab("targets")}
        >
          Set Targets
        </button>
        <button
          className={activeTab === "upload" ? "active" : ""}
          onClick={() => setActiveTab("upload")}
        >
          Upload Sales
        </button>
        <button
          className={activeTab === "salespersons" ? "active" : ""}
          onClick={() => setActiveTab("salespersons")}
        >
          Salespersons / Brands
        </button>
      </nav>

      <main className="tab-content">
        {activeTab === "dashboard" && (
          <section>
            <h2>Monthly Performance</h2>
            <div className="summary-cards">
              <div className="card">
                <h3>Total Target</h3>
                <p>₹ {formatCurrency(totalTargetAll)}</p>
              </div>
              <div className="card">
                <h3>Total Achievement</h3>
                <p>₹ {formatCurrency(totalAchAll)}</p>
              </div>
              <div className="card">
                <h3>Overall Completion</h3>
                <p>{formatPercent(overallPercent)}</p>
                <div className="progress-bar">
                  <div
                    className="progress-fill"
                    style={{
                      width: overallPercent
                        ? Math.min(overallPercent, 100) + "%"
                        : "0%"
                    }}
                  ></div>
                </div>
              </div>
            </div>

            {loadingDashboard ? (
              <p>Loading dashboard...</p>
            ) : (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>Salesperson</th>
                      <th>Brand</th>
                      <th>Target</th>
                      <th>Own Ach</th>
                      <th>Other Ach</th>
                      <th>Total Ach</th>
                      <th>Completion</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboardData.map((row) => {
                      const pct = row.totalPercent || 0;
                      let statusClass = "";
                      if (pct >= 90) statusClass = "good";
                      else if (pct >= 60) statusClass = "medium";
                      else statusClass = "low";

                      return (
                        <tr key={row.name}>
                          <td>{row.name}</td>
                          <td>{row.brand || "-"}</td>
                          <td>₹ {formatCurrency(row.target || 0)}</td>
                          <td>
                            ₹ {formatCurrency(row.ownAchievement || 0)}
                          </td>
                          <td>
                            ₹ {formatCurrency(row.otherAchievement || 0)}
                          </td>
                          <td>
                            ₹ {formatCurrency(row.totalAchievement || 0)}
                          </td>
                          <td>
                            <div className="percent-cell">
                              <span>{formatPercent(row.totalPercent)}</span>
                              <div className="progress-bar small">
                                <div
                                  className={`progress-fill ${statusClass}`}
                                  style={{
                                    width: pct
                                      ? Math.min(pct, 100) + "%"
                                      : "0%"
                                  }}
                                ></div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {dashboardData.length === 0 && (
                      <tr>
                        <td colSpan="7" style={{ textAlign: "center" }}>
                          No data for this month
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {activeTab === "targets" && (
          <section>
            <h2>Set Monthly Targets (Bulk)</h2>
            <p className="hint">
              Edit targets for all salespersons for {month}/{year} and click
              “Save All Targets”.
            </p>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Salesperson</th>
                    <th>Brand</th>
                    <th>Target (₹)</th>
                  </tr>
                </thead>
                <tbody>
                  {targetsTable.map((row, index) => (
                    <tr key={row.name}>
                      <td>{row.name}</td>
                      <td>{row.brand || "-"}</td>
                      <td>
                        <input
                          type="number"
                          value={row.target}
                          onChange={(e) =>
                            handleTargetChange(index, e.target.value)
                          }
                          style={{ width: "120px" }}
                        />
                      </td>
                    </tr>
                  ))}
                  {targetsTable.length === 0 && (
                    <tr>
                      <td colSpan="3" style={{ textAlign: "center" }}>
                        No salespersons found for targets
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <button onClick={handleSaveAllTargets}>Save All Targets</button>
          </section>
        )}

        {activeTab === "upload" && (
          <section>
            <h2>Upload Sales Excel (All Salespersons)</h2>
            <form className="form" onSubmit={handleUploadSales}>
              <label>
                Excel file:
                <input
                  type="file"
                  accept=".xls,.xlsx"
                  onChange={(e) => setUploadFile(e.target.files[0] || null)}
                />
              </label>
              <button type="submit">Upload and Process</button>
            </form>
            {uploadStatus && <p className="status">{uploadStatus}</p>}
            <p className="hint">
              Upload one Excel file that contains all salespersons. The backend
              will read each <code>Salesperson : NAME</code> block and apply all
              the business rules automatically.
            </p>
          </section>
        )}

        {activeTab === "salespersons" && (
          <section>
            <h2>Salespersons and Brand Mapping</h2>

            <form className="form" onSubmit={handleAddSalesperson}>
              <label>
                New salesperson name:
                <input
                  type="text"
                  value={spName}
                  onChange={(e) => setSpName(e.target.value)}
                  placeholder="Example: SATHIYA"
                />
              </label>
              <label>
                Brand (optional):
                <input
                  type="text"
                  value={spBrand}
                  onChange={(e) => setSpBrand(e.target.value)}
                  placeholder="Example: VIDEUM"
                />
              </label>
              <button type="submit">Add Salesperson</button>
            </form>

            <p className="hint">
              Edit brands directly in the table below and click “Save All
              Brands”.
            </p>

            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Salesperson</th>
                    <th>Brand</th>
                  </tr>
                </thead>
                <tbody>
                  {brandTable.map((row, index) => (
                    <tr key={row.id}>
                      <td>{row.name}</td>
                      <td>
                        <input
                          type="text"
                          value={row.brand}
                          onChange={(e) =>
                            handleBrandChange(index, e.target.value)
                          }
                          placeholder="-"
                          style={{ width: "140px" }}
                        />
                      </td>
                    </tr>
                  ))}
                  {brandTable.length === 0 && (
                    <tr>
                      <td colSpan="2" style={{ textAlign: "center" }}>
                        No salespersons yet
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <button onClick={handleSaveAllBrands}>Save All Brands</button>
          </section>
        )}
      </main>
    </div>
  );
}

export default App;
