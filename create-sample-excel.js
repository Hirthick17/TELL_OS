// create-sample-excel.js
// Run: node create-sample-excel.js
// Creates a sample test Excel file with Products, Orders, Inventory, Payments sheets

const XLSX = require('xlsx');
const path = require('path');

const products = [
  { 'Product ID': 'P001', 'Product Name': 'Cotton Kurta - Blue', 'Category': 'Clothing', 'Price': 899, 'SKU': 'KRT-BLU-001', 'Brand': 'FashionHub', 'Description': 'Comfortable cotton kurta' },
  { 'Product ID': 'P002', 'Product Name': 'Silk Saree - Red', 'Category': 'Clothing', 'Price': 2499, 'SKU': 'SAR-RED-002', 'Brand': 'FashionHub', 'Description': 'Premium silk saree' },
  { 'Product ID': 'P003', 'Product Name': 'Leather Wallet', 'Category': 'Accessories', 'Price': 599, 'SKU': 'WAL-LTH-003', 'Brand': 'StyleCraft', 'Description': 'Genuine leather wallet' },
  { 'Product ID': 'P004', 'Product Name': 'Handmade Earrings', 'Category': 'Jewelry', 'Price': 349, 'SKU': 'EAR-HND-004', 'Brand': 'ArtisanGems', 'Description': 'Handcrafted silver earrings' },
  { 'Product ID': 'P005', 'Product Name': 'Scented Candle Set', 'Category': 'Home Decor', 'Price': 449, 'SKU': 'CND-SCT-005', 'Brand': 'HomeGlow', 'Description': 'Aromatherapy candle set of 3' },
];

const orders = [
  { 'Order ID': 'ORD-001', 'Customer Name': 'Priya Sharma', 'Email': 'priya@example.com', 'Phone': '9876543210', 'Product': 'Cotton Kurta - Blue', 'Quantity': 2, 'Amount': 1798, 'Status': 'Delivered', 'Order Date': '2024-01-15' },
  { 'Order ID': 'ORD-002', 'Customer Name': 'Rahul Verma', 'Email': 'rahul@example.com', 'Phone': '9876543211', 'Product': 'Silk Saree - Red', 'Quantity': 1, 'Amount': 2499, 'Status': 'Processing', 'Order Date': '2024-01-16' },
  { 'Order ID': 'ORD-003', 'Customer Name': 'Anita Patel', 'Email': 'anita@example.com', 'Phone': '9876543212', 'Product': 'Leather Wallet', 'Quantity': 3, 'Amount': 1797, 'Status': 'Shipped', 'Order Date': '2024-01-17' },
  { 'Order ID': 'ORD-004', 'Customer Name': 'Kiran Kumar', 'Email': 'kiran@example.com', 'Phone': '9876543213', 'Product': 'Handmade Earrings', 'Quantity': 2, 'Amount': 698, 'Status': 'Delivered', 'Order Date': '2024-01-18' },
  { 'Order ID': 'ORD-005', 'Customer Name': 'Meena Iyer', 'Email': 'meena@example.com', 'Phone': '9876543214', 'Product': 'Scented Candle Set', 'Quantity': 1, 'Amount': 449, 'Status': 'Pending', 'Order Date': '2024-01-19' },
];

const inventory = [
  { 'Product Name': 'Cotton Kurta - Blue', 'SKU': 'KRT-BLU-001', 'Stock': 45, 'Reorder Level': 10, 'Warehouse': 'Chennai-Main' },
  { 'Product Name': 'Silk Saree - Red', 'SKU': 'SAR-RED-002', 'Stock': 12, 'Reorder Level': 5, 'Warehouse': 'Chennai-Main' },
  { 'Product Name': 'Leather Wallet', 'SKU': 'WAL-LTH-003', 'Stock': 3, 'Reorder Level': 10, 'Warehouse': 'Mumbai-Hub' },
  { 'Product Name': 'Handmade Earrings', 'SKU': 'EAR-HND-004', 'Stock': 28, 'Reorder Level': 8, 'Warehouse': 'Chennai-Main' },
  { 'Product Name': 'Scented Candle Set', 'SKU': 'CND-SCT-005', 'Stock': 60, 'Reorder Level': 15, 'Warehouse': 'Bangalore-Store' },
];

const payments = [
  { 'Payment ID': 'PAY-001', 'Order ID': 'ORD-001', 'Customer': 'Priya Sharma', 'Amount': 1798, 'Payment Method': 'UPI', 'Status': 'Completed', 'Payment Date': '2024-01-15' },
  { 'Payment ID': 'PAY-002', 'Order ID': 'ORD-002', 'Customer': 'Rahul Verma', 'Amount': 2499, 'Payment Method': 'Credit Card', 'Status': 'Completed', 'Payment Date': '2024-01-16' },
  { 'Payment ID': 'PAY-003', 'Order ID': 'ORD-003', 'Customer': 'Anita Patel', 'Amount': 1797, 'Payment Method': 'Net Banking', 'Status': 'Completed', 'Payment Date': '2024-01-17' },
  { 'Payment ID': 'PAY-004', 'Order ID': 'ORD-004', 'Customer': 'Kiran Kumar', 'Amount': 698, 'Payment Method': 'UPI', 'Status': 'Completed', 'Payment Date': '2024-01-18' },
  { 'Payment ID': 'PAY-005', 'Order ID': 'ORD-005', 'Customer': 'Meena Iyer', 'Amount': 449, 'Payment Method': 'COD', 'Status': 'Pending', 'Payment Date': '' },
];

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(products), 'Products');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(orders), 'Orders');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(inventory), 'Inventory');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(payments), 'Payments');

const outputPath = path.join(__dirname, 'sample-store-data.xlsx');
XLSX.writeFile(wb, outputPath);
console.log('✅ Sample Excel created: sample-store-data.xlsx');
console.log('   - 5 Products');
console.log('   - 5 Orders');
console.log('   - 5 Inventory items');
console.log('   - 5 Payment records');
