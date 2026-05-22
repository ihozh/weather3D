#pragma once

#include "CoreMinimal.h"
#include "WeatherTwinTypes.h"

class WEATHERTWIN_API FWeatherTwinDataLibrary
{
public:
    static FString ResolveDataPath(const FString& RelativeOrAbsolutePath);
    static bool LoadCloudVolume(const FString& MetaPath, TArray<uint8>& OutBytes, FWeatherVolumeMeta& OutMeta);
    static bool LoadWindFrame(const FString& MetaPath, TArray<float>& OutU, TArray<float>& OutV, TArray<float>& OutW, FWeatherVolumeMeta& OutMeta);

private:
    static bool ReadJsonObject(const FString& Path, TSharedPtr<FJsonObject>& OutObject);
};
