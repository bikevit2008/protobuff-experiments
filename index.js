const net = require('net');
const protobuf = require('protobufjs');
const fs = require('fs');
const sharp = require('sharp');

const protoFile = './hyperion.proto';

protobuf.load(protoFile, (err, root) => {
    if (err) {
        console.error('Ошибка при загрузке proto файла:', err);
        return;
    }
    // Получаем нужные типы сообщений
    const HyperionRequest = root.lookupType('proto.HyperionRequest');
    const HyperionReply = root.lookupType('proto.HyperionReply');
    const HyperionReplyEnum = HyperionReply.lookupEnum('Type');
    const HyperionCommandEnum = HyperionRequest.lookupEnum('Command');

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
                            
                            // Создаем raw изображение из RGB данных
                            sharp(Buffer.from(imageReq.imagedata), {
                                raw: {
                                    width: width,
                                    height: height,
                                    channels: 3
                                }
                            })
                            .resize(362, 185, {
                                kernel: 'lanczos3',
                                fit: 'fill'
                            })
                            .toFormat('png')
                            .toFile('output.png')
                            .then(() => {
                                console.log('Изображение сохранено как output.png');
                                // process.exit(0);
                            })
                            .catch(err => {
                                console.error('Ошибка при сохранении изображения:', err);
                            });

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