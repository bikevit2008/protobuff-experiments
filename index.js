const net = require('net');
const protobuf = require('protobufjs');
const ws281x = require('rpi-ws281x');

const protoFile = './hyperion.proto';

// Функция для тестового заполнения всех светодиодов одним цветом
function fillColor(pixels, r, g, b) {
    const color = (g << 16) | (r << 8) | b;
    for(let i = 0; i < pixels.length; i++) {
        pixels[i] = color;
    }
}

protobuf.load(protoFile, (err, root) => {
    if (err) {
        console.error('Ошибка при загрузке proto файла:', err);
        return;
    }

    const HyperionRequest = root.lookupType('proto.HyperionRequest');
    const HyperionReply = root.lookupType('proto.HyperionReply');
    const HyperionReplyEnum = HyperionReply.lookupEnum('Type');
    const HyperionCommandEnum = HyperionRequest.lookupEnum('Command');

    // Общее количество LED
    const LED_COUNT = 1083; // Тестовое количество

    console.log('Инициализация WS281x...');
    try {
        // Инициализация LED ленты
        ws281x.configure({
            leds: LED_COUNT,
            stripType: 'grb',
            gpio: 18,
            dma: 10,
            brightness: 255
        });
        console.log('WS281x успешно сконфигурирован');
    } catch (error) {
        console.error('Ошибка при конфигурации WS281x:', error);
        process.exit(1);
    }

    let pixels = new Uint32Array(LED_COUNT);
    
    // Тестовое заполнение белым цветом
    console.log('Тестовое заполнение белым цветом...');
    fillColor(pixels, 255, 255, 255);  // Полный белый цвет
    try {
        ws281x.render(pixels);
        console.log('Тестовый белый цвет отправлен на ленту');
    } catch (error) {
        console.error('Ошибка при отправке тестового цвета:', error);
    }

    // Очистка при выходе
    process.on('SIGINT', function () {
        console.log('Очистка WS281x...');
        ws281x.reset();
        process.nextTick(function () { process.exit(0); });
    });

    // Создаем TCP сервер, который слушает порт 19445
    const server = net.createServer(socket => {
        console.log('Новое соединение от', socket.remoteAddress);
        
        // Создаем аккумулятор для входящих данных
        let buffer = Buffer.alloc(0);
        
        socket.on('data', data => {
            // Добавляем полученные данные к аккумулятору
            buffer = Buffer.concat([buffer, data]);

            // Обрабатываем все накопленные сообщения
            while (buffer.length >= 4) {
                // Читаем 4-байтовый заголовок с длиной сообщения
                const msgLength = buffer.readUInt32BE(0);

                // Если накоплено достаточно данных для полного сообщения
                if (buffer.length >= 4 + msgLength) {
                    const msgBuffer = buffer.slice(4, 4 + msgLength);

                    try {
                        const request = HyperionRequest.decode(msgBuffer);
                        console.log('Получен запрос:', request);
                        console.log('Декодированный месседж:', JSON.stringify(request, null, 2));

                        // Измененная проверка: сравниваем либо числовое значение, либо строку "IMAGE"
                        if ((request.command === HyperionCommandEnum.values.IMAGE || request.command === 'IMAGE') && request['.proto.ImageRequest.imageRequest']) {
                            const imageReq = request['.proto.ImageRequest.imageRequest'];
                            const width = imageReq.imagewidth;
                            const height = imageReq.imageheight;
                            
                            // Получаем RGB данные
                            const rgbData = Buffer.from(imageReq.imagedata);
                            
                            function interpolatePixels(sourcePixels, sourceCount, targetCount) {
                                const result = new Array(targetCount * 3); // RGB для каждого пикселя
                                
                                for (let i = 0; i < targetCount; i++) {
                                    // Вычисляем позицию в исходном массиве
                                    const sourcePos = (i * (sourceCount - 1) / (targetCount - 1));
                                    const sourceIndex = Math.floor(sourcePos) * 3;
                                    const fraction = sourcePos - Math.floor(sourcePos);
                                    
                                    // Если это последний пиксель или нет дробной части
                                    if (sourceIndex >= (sourceCount - 1) * 3 || fraction === 0) {
                                        result[i * 3] = sourcePixels[sourceIndex];     // G
                                        result[i * 3 + 1] = sourcePixels[sourceIndex + 1]; // R
                                        result[i * 3 + 2] = sourcePixels[sourceIndex + 2]; // B
                                    } else {
                                        // Интерполяция между двумя соседними пикселями
                                        for (let c = 0; c < 3; c++) {
                                            const start = sourcePixels[sourceIndex + c];
                                            const end = sourcePixels[sourceIndex + 3 + c];
                                            result[i * 3 + c] = Math.round(start + (end - start) * fraction);
                                        }
                                    }
                                }
                                
                                return Buffer.from(result);
                            }
                            
                            function extractAndResizeBorders(rgbData, width, height, targetSizes) {
                                // Создаем временные буферы для каждой стороны
                                const rightPixels = Buffer.alloc(height * 3);
                                const topPixels = Buffer.alloc(width * 3);
                                const leftPixels = Buffer.alloc(height * 3);
                                const bottomPixels = Buffer.alloc(width * 3);
                                
                                // Извлекаем правый столбец (снизу вверх)
                                for (let y = height - 1; y >= 0; y--) {
                                    const srcIndex = ((width - 1) + y * width) * 3;
                                    const destIndex = (height - 1 - y) * 3;
                                    rightPixels[destIndex + 1] = rgbData[srcIndex];     // R
                                    rightPixels[destIndex] = rgbData[srcIndex + 1];     // G
                                    rightPixels[destIndex + 2] = rgbData[srcIndex + 2]; // B
                                }
                                
                                // Извлекаем верхнюю строку (справа налево)
                                for (let x = width - 1; x >= 0; x--) {
                                    const srcIndex = x * 3;
                                    const destIndex = (width - 1 - x) * 3;
                                    topPixels[destIndex + 1] = rgbData[srcIndex];     // R
                                    topPixels[destIndex] = rgbData[srcIndex + 1];     // G
                                    topPixels[destIndex + 2] = rgbData[srcIndex + 2]; // B
                                }
                                
                                // Извлекаем левый столбец (сверху вниз)
                                for (let y = 0; y < height; y++) {
                                    const srcIndex = y * width * 3;
                                    const destIndex = y * 3;
                                    leftPixels[destIndex + 1] = rgbData[srcIndex];     // R
                                    leftPixels[destIndex] = rgbData[srcIndex + 1];     // G
                                    leftPixels[destIndex + 2] = rgbData[srcIndex + 2]; // B
                                }
                                
                                // Извлекаем нижнюю строку (слева направо)
                                for (let x = 0; x < width; x++) {
                                    const srcIndex = (x + (height - 1) * width) * 3;
                                    const destIndex = x * 3;
                                    bottomPixels[destIndex + 1] = rgbData[srcIndex];     // R
                                    bottomPixels[destIndex] = rgbData[srcIndex + 1];     // G
                                    bottomPixels[destIndex + 2] = rgbData[srcIndex + 2]; // B
                                }
                                
                                // Интерполируем каждую сторону до нужного размера
                                const resizedRight = interpolatePixels(rightPixels, height, targetSizes.vertical_right);
                                const resizedTop = interpolatePixels(topPixels, width, targetSizes.horizontal_top);
                                const resizedLeft = interpolatePixels(leftPixels, height, targetSizes.vertical_left);
                                const resizedBottom = interpolatePixels(bottomPixels, width, targetSizes.horizontal_bottom);
                                
                                // Объединяем все стороны в один буфер
                                return Buffer.concat([
                                    resizedRight,
                                    resizedTop,
                                    resizedLeft,
                                    resizedBottom
                                ]);
                            }
                            
                            // Задаем целевые размеры для каждой стороны
                            const targetSizes = {
                                vertical_right: 185,
                                horizontal_top: 362,
                                vertical_left: 185,
                                horizontal_bottom: 361
                            };
                            
                            // Получаем интерполированные границы
                            const borderPixels = extractAndResizeBorders(rgbData, width, height, targetSizes);
                            
                            console.log('Размер исходного буфера:', rgbData.length);
                            console.log('Размер буфера границ после интерполяции:', borderPixels.length);
                            
                            // Преобразуем RGB буфер в uint32 массив для WS281x
                            for (let i = 0; i < borderPixels.length; i += 3) {
                                const pixelIndex = Math.floor(i / 3);
                                // Формат GRB (как в borderPixels) уже соответствует формату WS281x
                                const g = borderPixels[i+1];
                                const r = borderPixels[i];
                                const b = borderPixels[i + 2];
                                pixels[pixelIndex] = (g << 16) | (r << 8) | b;
                                if (pixelIndex < 5) {
                                    console.log(`Пиксель ${pixelIndex}: R=${r}, G=${g}, B=${b}, HEX=${pixels[pixelIndex].toString(16)}`);
                                }
                            }
                            
                            // Отправляем данные на ленту
                            console.log('Отправка данных на ленту...');
                            try {
                                ws281x.render(pixels);
                                console.log('Данные успешно отправлены');
                            } catch (error) {
                                console.error('Ошибка при отправке данных на ленту:', error);
                            }
                            
                            // Формируем ответное сообщение
                            const replyPayload = {
                                type: HyperionReplyEnum.values.REPLY,
                                success: true
                            };
                            const replyMessage = HyperionReply.create(replyPayload);
                            const encodedReply = HyperionReply.encode(replyMessage).finish();

                            // Добавляем 4-байтовый префикс длины к ответу
                            const header = Buffer.alloc(4);
                            header.writeUInt32BE(encodedReply.length, 0);
                            socket.write(Buffer.concat([header, encodedReply]));
                        }
                    } catch (e) {
                        console.error('Ошибка обработки сообщения:', e);
                    }

                    // Удаляем обработанное сообщение из буфера
                    buffer = buffer.slice(4 + msgLength);
                } else {
                    // Если данных недостаточно, выходим из цикла
                    break;
                }
            }
        });
        
        socket.on('error', err => {
            console.error('Ошибка сокета:', err);
        });
    });

    server.listen(19445, () => {
        console.log('Сервер запущен и слушает порт 19445');
    });
});