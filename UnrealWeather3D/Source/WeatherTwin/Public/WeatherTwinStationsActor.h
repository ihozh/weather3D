#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "WeatherTwinTypes.h"
#include "WeatherTwinStationsActor.generated.h"

class UInstancedStaticMeshComponent;

UCLASS()
class WEATHERTWIN_API AWeatherTwinStationsActor : public AActor
{
    GENERATED_BODY()

public:
    AWeatherTwinStationsActor();

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    FWeatherTwinRegion Region;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="Weather Twin")
    TArray<FMesonetStation> Stations;

protected:
    virtual void OnConstruction(const FTransform& Transform) override;

private:
    UPROPERTY(VisibleAnywhere)
    UInstancedStaticMeshComponent* StationMarkers = nullptr;

    UPROPERTY(VisibleAnywhere)
    UInstancedStaticMeshComponent* StationMasts = nullptr;

    void PopulateDefaultStations();
};
