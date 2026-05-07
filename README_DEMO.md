\# Smart Aquarium IoT - Kịch bản chạy demo



\## 1. Chạy backend



Mở PowerShell:



```powershell

cd "D:\\HK8\\IoT\\IoT\\smart-aquarium-backend"

npm run dev



Backend chạy đúng khi thấy

Server đang chạy tại http://localhost:5000

Socket.io realtime đã sẵn sàng tại path /realtime

Kết nối MariaDB thành công

MQTT Broker kết nối thành công!

Đã subscribe topic sensor



Kiểm tra backend:



Invoke-RestMethod -Uri "http://localhost:5000/api/health" -Method GET

