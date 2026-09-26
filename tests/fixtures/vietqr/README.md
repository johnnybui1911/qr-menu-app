# VietQR reference vector

`sample.txt` is the published output of `vietqr.Generate(120000, "970415", "0011001932418", "ủng hộ lũ lụt")` from
https://github.com/subiz/vietqr (README, "Sử dụng"). The library strips diacritics, so the transfer content is
`ung ho lu lut`. Its CRC16-CCITT-FALSE checksum (`C15C`) was verified independently.

Inputs for the generator under test: bank BIN `970415`, account `0011001932418`, amount `120000` VND,
content `ung ho lu lut`.
