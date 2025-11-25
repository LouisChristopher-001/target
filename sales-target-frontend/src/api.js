import axios from "axios";

const api = axios.create({
  baseURL: "https://target-qsx5.onrender.com" // your backend URL
});

export default api;
